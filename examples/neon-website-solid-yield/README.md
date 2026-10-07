# Neon Website: solid-yield + API

A Tailwind [solid-yield](https://github.com/devagrawal09/solid-yield) SPA
(`Neon.Website.SolidYield`) that loads a greeting from an Effect API on a
`Neon.Function`. Both run on Neon Functions inside one `Neon.Project`.

- `src/app.tsx` loads `GET /api/greeting` in a `$memo` through `attempt`, so
  the greeting is typed as pending and failing with `ApiError`. `Loading` and
  `Errored` discharge both colors before `render` accepts the app.
- `src/api.ts` is the Effect API Function. Its URL is inlined into the client
  bundle as `VITE_API_URL`.
- `src/project.ts` declares the shared Neon project.
- Tailwind CSS v4 runs through `@tailwindcss/vite` next to the solid-yield and
  Solid plugins in `vite.config.ts`.

solid-yield has no npm release yet; this example installs the tarballs in
[`vendor/solid-yield`](../../vendor/solid-yield).

```sh
bun run deploy   # build + deploy the SPA and the API
bun run dev      # Vite dev server with HMR; the API runs locally too
bun run destroy
```
