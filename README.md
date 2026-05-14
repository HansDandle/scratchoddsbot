# ScratchScout Reddit Bot

A Reddit bot that replies to comments containing scratch-off game codes (e.g. `$TX123`) with current odds, prize tiers, and remaining ticket data from publicly available state lottery sources.

Built with [Devvit](https://developers.reddit.com/) on Reddit's developer platform.

## Usage

Mention a game in any comment using the format `$STATE###` (e.g. `$TX123`, `$AZ42`). The bot will reply with current prize tier odds.

Supported states: TX, FL, OR, MN, AZ, NY, CA, NJ, GA, OH, MA, CO, NE, MT

## Commands

- `npm run dev` — Start a live playtest on your dev subreddit
- `npm run build` — Build client and server
- `npm run deploy` — Upload a new version
- `npm run launch` — Publish for public review
- `npm run login` — Log the CLI into Reddit

## Legal

- [Privacy Policy](PRIVACY.md)
- [Terms & Conditions](TERMS.md)
