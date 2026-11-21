# discord-bot

A Discord bot on a Cloudflare Worker: a category with an announcements and a deploys channel, a webhook, and `/ping` and `/announce` slash commands answered by the Worker.

## Setup

1. Create an application and bot ([Setup](https://alchemy.run/discord/setup)), and invite the bot to a server named `alchemy-test` (or change the name in `src/Guild.ts`).
2. `alchemy profile edit --add Discord` and paste the bot token.

## Run

```sh
pnpm deploy   # creates the channels, webhook and commands; points Discord at the Worker
pnpm test     # deploys, posts through the webhook, checks the message, destroys
pnpm destroy
```

Deploying sets the application's interactions endpoint to the Worker. Destroy restores the previous one.
