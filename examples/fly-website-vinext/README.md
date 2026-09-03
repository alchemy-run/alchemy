# Fly Website: vinext

Deploys a [vinext](https://vinext.dev) site to Fly with
`Fly.Website.Vinext` — Next.js API on Vite, as a long-running Node
process on a Machine. Not OpenNext and not the Cloudflare Worker path.
ISR / `"use cache"` persist in Upstash Redis (`vinext({ ...alchemy() })`).

```ts
const redis = yield* Fly.Redis("Cache", { eviction: true });
const site = yield* Fly.Website.Vinext("Vinext", {
  redis,
  env: { GREETING: "Hello from vinext on Fly!" },
});
```

```sh
bun add -d @alchemy.run/frontend-frameworks
bun run deploy
bun run dev
bun run destroy
```
