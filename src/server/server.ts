import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { context, reddit, redis } from "@devvit/web/server";
import type {
  PartialJsonValue,
  TriggerResponse,
  UiResponse,
} from "@devvit/web/shared";
import {
  ApiEndpoint,
  type DecrementRequest,
  type DecrementResponse,
  type IncrementRequest,
  type IncrementResponse,
  type InitResponse,
} from "../shared/api.ts";

// ── In-memory cache (populated from Redis on first use, refreshed by scheduler) ──

// Kept for future use once gist.githubusercontent.com domain is approved
// const GIST_BASE = "https://gist.githubusercontent.com/HansDandle/8216580aa3673f9a5fe246ffcf51f759/raw";
const TRIGGER_RE = /\$([A-Za-z]{2})(\d+)/g;
const SUPPORTED_STATES = ["TX","FL","OR","MN","AZ","NY","CA","NJ","GA","OH","MA","CO","NE","MT"];

const BOT_FOOTER = [
  "",
  "---",
  "^(Check [ScratchScout.com](https://scratchscout.com) for odds, EV, and prize counts on scratch-off games across 15 states. 18+ only. Play responsibly.)",
].join("\n");

// Module-level cache — survives across requests, reset only on process restart
const gamesCache: Record<string, any[]> = {};
let cacheLoaded = false;

async function ensureCacheLoaded(): Promise<void> {
  if (cacheLoaded) return;
  await Promise.all(
    SUPPORTED_STATES.map(async (state) => {
      const raw = await redis.get(`games:${state}`);
      if (raw) {
        gamesCache[state] = JSON.parse(raw);
        console.log(`[${state}] Loaded ${gamesCache[state]?.length ?? 0} games from Redis`);
      } else {
        console.log(`[${state}] Redis empty, falling back to wiki`);
        await refreshStateFromWiki(state);
      }
    })
  );
  cacheLoaded = true;
}

async function refreshStateFromWiki(state: string): Promise<void> {
  try {
    const wikiPage = await reddit.getWikiPage("scratchoddsbot_dev", state.toLowerCase());
    const games = JSON.parse(wikiPage.content) as any[];
    gamesCache[state] = games;
    await redis.set(`games:${state}`, JSON.stringify(games));
    console.log(`[${state}] Cache refreshed from wiki: ${games.length} games`);
  } catch (err) {
    console.error(`[${state}] Wiki fetch failed: ${err}`);
  }
}

// ── Bot formatting ─────────────────────────────────────────────────────────────

function findGame(state: string, number: string): any | null {
  const games = gamesCache[state.toUpperCase()] ?? [];
  const normalized = number.replace(/^0+/, "");
  return games.find((g) => String(g.gameNumber ?? "").replace(/^0+/, "") === normalized) ?? null;
}

function formatReply(state: string, game: any): string {
  const tiers = (game.prizeBreakdown ?? []).filter((t: any) => t.totalInGame > 0);
  const header = `**Prize tiers & odds — ${state.toUpperCase()}${game.gameNumber}: ${game.gameName}**\nTicket price: $${game.ticketPrice}\n`;
  const tableHeader = "| Prize | Remaining | Current Odds | Starting Odds |\n|:------|----------:|:-------------|:--------------|";
  const rows = tiers.map((t: any) => {
    const startingOdds =
      game.totalTickets && t.totalInGame > 0
        ? `1 in ${Math.round(game.totalTickets / t.totalInGame).toLocaleString()}`
        : "N/A";
    return `| ${t.amount} | ${t.remaining.toLocaleString()}/${t.totalInGame.toLocaleString()} | ${t.odds} | ${startingOdds} |`;
  });
  const overall = game.currentOverallOdds || game.overallOdds;
  const overallLine = overall ? `\nOverall odds of winning any prize: **${overall}**` : "";
  return [header, tableHeader, ...rows, overallLine, BOT_FOOTER].join("\n");
}

// ── Request handlers ───────────────────────────────────────────────────────────

async function onCommentCreate(req: IncomingMessage): Promise<TriggerResponse> {
  console.log("[onCommentCreate] handler fired");
  await ensureCacheLoaded();
  console.log("[onCommentCreate] cache loaded, TX games:", gamesCache["TX"]?.length ?? 0);

  const body = await readJSON<{ comment?: { id?: string; body?: string } }>(req).catch(() => ({}));
  const commentBody = body.comment?.body ?? "";
  const commentId = body.comment?.id;
  if (!commentId || !commentBody) return {};

  const matches = [...commentBody.matchAll(TRIGGER_RE)];
  if (!matches.length) return {};

  const seen = new Set<string>();
  const blocks: string[] = [];

  for (const [, state, number] of matches) {
    const key = `${state.toUpperCase()}:${number.replace(/^0+/, "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const game = findGame(state, number);
    if (game) blocks.push(formatReply(state, game));
  }

  if (!blocks.length) return {};

  await reddit.submitComment({ id: commentId, text: blocks.join("\n\n---\n\n") });
  return {};
}

async function onRefreshGames(): Promise<TriggerResponse> {
  // Refresh all states from gist into Redis + in-memory cache
  await Promise.all(SUPPORTED_STATES.map(refreshStateFromWiki));
  return {};
}

// ── HTTP server ────────────────────────────────────────────────────────────────

export async function serverOnRequest(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  try {
    await onRequest(req, rsp);
  } catch (err) {
    const msg = `server error; ${err instanceof Error ? err.stack : err}`;
    console.error(msg);
    writeJSON<ErrorResponse>(500, { error: msg, status: 500 }, rsp);
  }
}

async function onRequest(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  const url = req.url;

  if (!url || url === "/") {
    writeJSON<ErrorResponse>(404, { error: "not found", status: 404 }, rsp);
    return;
  }

  const endpoint = url as ApiEndpoint;

  let body: ApiResponse | UiResponse | ErrorResponse | TriggerResponse;
  switch (endpoint) {
    case ApiEndpoint.Init:
      body = await onInit();
      break;
    case ApiEndpoint.Increment:
      body = await onIncrement(req);
      break;
    case ApiEndpoint.Decrement:
      body = await onDecrement(req);
      break;
    case ApiEndpoint.OnPostCreate:
      body = await onMenuNewPost();
      break;
    case ApiEndpoint.OnAppInstall:
      body = await onAppInstall();
      break;
    case ApiEndpoint.OnCommentCreate:
      body = await onCommentCreate(req);
      break;
    case ApiEndpoint.RefreshGames:
      body = await onRefreshGames();
      break;
    default:
      endpoint satisfies never;
      body = { error: "not found", status: 404 };
      break;
  }

  writeJSON<PartialJsonValue>("status" in body ? (body as any).status : 200, body, rsp);
}

type ApiResponse = InitResponse | IncrementResponse | DecrementResponse;
type ErrorResponse = { error: string; status: number };

function getPostId(): string {
  if (!context.postId) throw Error("no post ID");
  return context.postId;
}

function getPostCountKey(postId: string): string {
  return `count:${postId}`;
}

async function onInit(): Promise<InitResponse> {
  const postId = getPostId();
  const count = Number((await redis.get(getPostCountKey(postId))) ?? 0);
  return { type: "init", postId, count, username: context.username ?? "user" };
}

async function onIncrement(req: IncomingMessage): Promise<IncrementResponse> {
  const postId = getPostId();
  const { amount } = await readJSON<IncrementRequest>(req).catch(() => ({ amount: 1 }));
  const incrementBy = Number.isFinite(amount) ? amount : 1;
  const count = await redis.incrBy(getPostCountKey(postId), incrementBy);
  return { type: "increment", postId, count };
}

async function onDecrement(req: IncomingMessage): Promise<DecrementResponse> {
  const postId = getPostId();
  const { amount } = await readJSON<DecrementRequest>(req).catch(() => ({ amount: 1 }));
  const parsedAmount = typeof amount === "number" ? amount : Number(amount);
  const decrementBy = Number.isFinite(parsedAmount) ? parsedAmount : 1;
  const count = Number(await redis.incrBy(getPostCountKey(postId), -decrementBy));
  return { type: "decrement", postId, count };
}

async function onMenuNewPost(): Promise<UiResponse> {
  const post = await reddit.submitCustomPost({ title: context.appName });
  return {
    showToast: { text: `Post ${post.id} created.`, appearance: "success" },
    navigateTo: post.url,
  };
}

async function onAppInstall(): Promise<TriggerResponse> {
  await reddit.submitCustomPost({ title: "scratchoddsbot" });
  // Seed Redis cache on install
  await Promise.allSettled(SUPPORTED_STATES.map(refreshStateFromWiki));
  return {};
}

function writeJSON<T extends PartialJsonValue>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json);
  const len = Buffer.byteLength(body);
  rsp.writeHead(status, {
    "Content-Length": len,
    "Content-Type": "application/json",
  });
  rsp.end(body);
}

async function readJSON<T>(req: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  await once(req, "end");
  return JSON.parse(`${Buffer.concat(chunks)}`);
}
