# Hetzner Website: solid-yield + API

A Tailwind [solid-yield](https://github.com/devagrawal09/solid-yield) SPA
(`Hetzner.Website.SolidYield`) that loads a greeting from an Effect
`Hetzner.Service` API. Both run on one shared `Hetzner.Server` (`cpx12` in
`fsn1`).

- `src/app.tsx` loads `GET /api/greeting` in a `$memo` through `attempt`, so
  the greeting is typed as pending and failing with `ApiError`. `Loading` and
  `Errored` discharge both colors before `render` accepts the app.
- `src/api.ts` is the Effect API Service on the shared Server. Its URL is
  inlined into the client bundle as `VITE_API_URL`.
- Tailwind CSS v4 runs through `@tailwindcss/vite` next to the solid-yield and
  Solid plugins in `vite.config.ts`.

solid-yield has no npm release yet; this example installs the tarballs in
[`vendor/solid-yield`](../../vendor/solid-yield).

```sh
export HCLOUD_TOKEN=...
bun run deploy   # build + deploy the SPA and the API
bun run dev      # Vite dev server with HMR
bun run destroy
```

The SPA is at `http://{ipv4}:3000`. The API is at `http://{ipv4}:3001`.
