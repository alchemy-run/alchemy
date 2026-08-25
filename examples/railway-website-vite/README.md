# Railway Website: Vite + Notes API

A Tailwind React SPA (`Railway.Website.Vite`) that reads and writes notes
through an Effect `Railway.Function` (canvas, no registry) persisted on
`Railway.Postgres`.

The Website image still needs `RAILWAY_REGISTRY` (GHCR / Docker Hub) on
deploy. The Function does not.

- `alchemy deploy` builds the SPA (inlining `VITE_API_URL`) and deploys
  Postgres + the Function + the static site.
- `alchemy dev` is Vite's own server (HMR included).

```sh
export RAILWAY_REGISTRY=ghcr.io/your-org
bun run deploy
```

```sh
bun run destroy
```
