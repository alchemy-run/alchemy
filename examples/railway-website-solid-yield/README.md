# Railway Website: solid-yield + API

A Tailwind [solid-yield](https://github.com/devagrawal09/solid-yield) SPA
(`Railway.Website.SolidYield`) that loads a greeting from an Effect API
(`Railway.Service`), both in one `Railway.Project`.

- `src/spec.ts` defines the API once as an Effect `HttpApi`. The backend
  implements it with `HttpApiBuilder`.
- `src/lib/api.ts` calls the backend with `HttpApiClient.make(GreetingApi, {
  baseUrl: VITE_API_URL })`, failing with `ApiError` (a solid-yield `Failure`).
- `src/lib/effect.ts` runs an Effect inside a solid-yield routine. The
  Effect's typed error becomes the routine's failure color.
- `src/app.tsx` runs the Effect in a `$memo`, so the greeting is typed as
  pending and failing with `ApiError`. `Loading` and `Errored` discharge both
  colors before `render` accepts the app. The Refresh `$event` re-runs it.
- `src/api.ts` is the Effect API Service. Alchemy generates its Dockerfile and
  Railway builds it. Its URL is inlined into the client bundle as
  `VITE_API_URL`.
- Tailwind CSS v4 runs through `@tailwindcss/vite` next to the solid-yield and
  Solid plugins in `vite.config.ts`.

solid-yield has no npm release yet; this example installs the tarballs in
[`vendor/solid-yield`](../../vendor/solid-yield).

```sh
bun run deploy   # build + deploy the SPA and the API
bun run dev      # Vite dev server with HMR
bun run destroy
```
