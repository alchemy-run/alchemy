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

`@foldkit/vite-plugin` automatically generates a shared build identity for the coordinated client and server builds. `renderToString` and `Runtime.hydrate` use it by default, so hydration can reject a page from another deployment without application code passing a build id.

## Commands

```sh
bun dev      # alchemy dev
bun deploy   # alchemy deploy
bun destroy  # alchemy destroy
```
