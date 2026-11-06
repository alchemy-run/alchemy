# Archil Website: Vite + Notes API

A Tailwind React SPA (`Archil.Website.Vite`) that reads and writes notes
through an Effect program in its own `Archil.Sandbox`. Each note is a JSON
file on an `Archil.Disk`, written through `Archil.ReadWriteDisk`. The site
runs in a second sandbox.

- `alchemy deploy` builds the SPA (inlining `VITE_API_URL`) and deploys
  both sandboxes.
- `alchemy dev` is Vite's own server (HMR included).

```sh
export ARCHIL_API_KEY=...
bun run deploy
```

The SPA is at `https://3000-<id>.<region>.archil.app`; the API is the
`3001-` hostname of the API's sandbox (`GET`/`POST /notes`). An idle
sandbox stops and starts again on the next request.

```sh
bun run destroy
```
