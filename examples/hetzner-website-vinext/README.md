# Hetzner Website: vinext

Deploys a [vinext](https://vinext.dev) site to a Hetzner Cloud Server
with `Hetzner.Website.Vinext` — Next.js API on Vite, as a long-running
Node systemd unit. Not OpenNext and not the Cloudflare Worker path.
ISR defaults to in-process memory; set `REDIS_URL` and register
`redisAdapter()` for a durable store.

```ts
const site = yield* Hetzner.Website.Vinext("Vinext", {
  env: { GREETING: "Hello from vinext on Hetzner!" },
});
```

```sh
bun add -d @alchemy.run/frontend-frameworks
bun run deploy
bun run dev
bun run destroy
```
