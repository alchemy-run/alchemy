# GCP Website: solid-yield + API

A Tailwind [solid-yield](https://github.com/devagrawal09/solid-yield) SPA
(`GCP.Website.SolidYield`, a Cloud Run service serving the Vite build) that
loads a greeting from an Effect API on Cloud Run (`GCP.Function`).

- `src/app.tsx` loads `GET /api/greeting` in a `$memo` through `attempt`, so
  the greeting is typed as pending and failing with `ApiError`. `Loading` and
  `Errored` discharge both colors before `render` accepts the app.
- `src/api.ts` is the Effect API on Cloud Run. Its URL is inlined into the
  client bundle as `VITE_API_URL`.
- Tailwind CSS v4 runs through `@tailwindcss/vite` next to the solid-yield and
  Solid plugins in `vite.config.ts`.

Both services are container images built locally, so deploying needs Docker.

solid-yield has no npm release yet; this example installs the tarballs in
[`vendor/solid-yield`](../../vendor/solid-yield).

```sh
bun run deploy   # build + deploy the SPA and the API
bun run dev      # Vite dev server with HMR
bun run destroy
```
