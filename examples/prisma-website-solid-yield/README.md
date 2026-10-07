# Prisma Website: solid-yield + API

A Tailwind [solid-yield](https://github.com/devagrawal09/solid-yield) SPA
(`Prisma.Website.SolidYield`) that loads a greeting from an Effect API on
Prisma Compute (`Prisma.Compute`). Both share one `Prisma.Project` created
without a database.

- `src/app.tsx` loads `GET /api/greeting` in a `$memo` through `attempt`, so
  the greeting is typed as pending and failing with `ApiError`. `Loading` and
  `Errored` discharge both colors before `render` accepts the app.
- `src/api.ts` is the Effect API on Prisma Compute. Its URL is inlined into the
  client bundle as `VITE_API_URL`.
- Tailwind CSS v4 runs through `@tailwindcss/vite` next to the solid-yield and
  Solid plugins in `vite.config.ts`.

`@vercel/nft` traces the website's Compute artifact. solid-yield has no npm
release yet; this example installs the tarballs in
[`vendor/solid-yield`](../../vendor/solid-yield).

```sh
bun run deploy --profile testing   # build + deploy the SPA and the API
bun run dev                        # Vite dev server with HMR; the API runs locally too
bun run destroy --profile testing
```
