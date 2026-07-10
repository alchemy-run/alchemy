# cloudflare-foldkit

A minimal [Foldkit](https://foldkit.dev) single-page app deployed to Cloudflare Workers with Alchemy's `Cloudflare.Website.Vite` resource.

Foldkit is an Elm-style frontend framework built on [Effect](https://effect.website): one immutable model, a closed union of messages, a single `update` fold, and a pure `view`. This example is the canonical counter — see [`src/main.ts`](./src/main.ts) for the whole architecture in one file.

## Project setup

```sh
bun install
```

### Develop

```sh
bun dev
```

### Build

```sh
bun run build
```

### Deploy

```sh
bun run deploy
```

### Destroy

```sh
bun run destroy
```

## Notes

- `effect` and `@effect/platform-browser` are pinned to `4.0.0-beta.88` — the exact peer version Foldkit is built against — instead of the workspace catalog. The app bundle resolves the pinned copy; the `alchemy` CLI keeps its own.
