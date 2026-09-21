# cloudflare-foldkit-ssr

A [Foldkit](https://foldkit.dev) app rendered on the server, deployed to Cloudflare with `Cloudflare.Website.Foldkit`.

The sibling [`cloudflare-foldkit`](../cloudflare-foldkit) example is the client-only shape: it ships a template and the browser builds the page. This one renders each request at the edge and the browser adopts that markup, so the document a crawler reads already carries the page.

## What makes it server-rendered

- `src/entry.server.ts` exposes `renderPage(Request)`. It derives Flags from the request, renders through the same `view` the browser uses, and returns the markup plus the document's title.
- `vite.config.ts` sets `ssr: { serverEntry, build: true }`, so the one `vite build` Alchemy runs emits `dist/server/fetch.js` next to the browser bundle — a Web `fetch` handler with the built shell embedded. Alchemy deploys it as the Worker, the same way it deploys a TanStack Start server bundle.
- `src/entry.ts` calls `Runtime.hydrate` rather than `Runtime.run`, so the client adopts the served DOM instead of rebuilding it.

Load `/?count=7` and view source: the count is in the HTML before any JavaScript runs.

## Nothing to configure

`alchemy.run.ts` declares the site and nothing else. The build writes `dist/server/foldkit.build.json` recording what it prerendered — nothing, here — and Alchemy derives the asset routing from it: the unrendered `index.html` is left out of the upload, files are served straight from the asset layer, and everything else reaches the handler, which answers asset misses with a 404 and renders pages.

## The build id

`renderToString` and `Runtime.hydrate` both require a build id, and hydration refuses a page whose id is not the running build's. `vite.config.ts` takes it from `FOLDKIT_BUILD_ID` and stores a generated fallback back into the environment, so a local build always has one and every config read within a build resolves the same id. A real deployment should pass a value it already has, such as a commit or release tag, and give the client and server builds the same one. It is published in the page, so it must not be a secret.

## Commands

```sh
bun dev      # alchemy dev
bun deploy   # alchemy deploy
bun destroy  # alchemy destroy
```
