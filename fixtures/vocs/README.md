# @fixtures/vocs

E2E fixture for [vocs](https://vocs.dev) (the minimal React documentation
framework) on Cloudflare Workers.

> **Workspace patch**: `patches/vocs@2.6.0.patch` (registered in the root
> `package.json` `patchedDependencies`) fixes an upstream infinite recursion
> in `getMdxLayoutImport` that crashes every MDX build on Windows. Filed and
> fixed upstream — [wevm/vocs#611](https://github.com/wevm/vocs/issues/611) /
> [wevm/vocs#612](https://github.com/wevm/vocs/pull/612); drop the patch when
> bumping to a vocs release containing the fix. The patch only affects this
> workspace's install — users bring their own vocs.

Vocs 2.x is built on **waku**: its `vocs()` vite plugin (public export
`vocs/vite`) composes waku's own `waku/vite-plugins` (environments,
adapter-alias, static-build, ...) with vocs's mdx/config/patch plugins, and it
peer-depends on `waku ^1.0.0-beta.6`. It is _not_ a fully static site: page
bodies are prerendered RSC elements, but the document shell is SSR'd per
request and there are dynamic API routes (`/api/search`, `/api/og`,
`/api/mcp`, `/api/feedback`) — so it runs as a worker.

Vocs does not use waku's `unstable_combinedPlugins`, so the
`@alchemy.run/frontend-frameworks/waku` Framework layer can't drive it directly. Instead,
`framework.ts` is a fixture-local `Framework` implementation that mirrors
`packages/waku`'s orchestration with vocs's plugin stack swapped in, reusing
the deploy-target halves from `@alchemy.run/frontend-frameworks/waku/cloudflare` (the
wrangler-free adapter fork, selected through vocs's `unstable_adapter`
passthrough, + the cloudflare vite plugin pinned to waku's rsc entry).

There is no `vite.config.ts` and no `wrangler.jsonc`: `e2e.config.ts` carries
the entire worker configuration in memory; `vocs.config.ts` is vocs's own
(platform-agnostic) docs config.

## What it exercises

- **Worker SSR** — the docs shell (sidebar, layout) is rendered by the worker
  at request time in both dev (workerd module-runner) and preview (miniflare).
- **MDX pages** — `src/pages/*.mdx` with sidebar navigation.
- **Client interactivity** — `src/components/Counter.tsx` is a
  `"use client"` component embedded in MDX, hydrated in the browser.
- **Static assets** — `public/hello.txt` rides along in `dist/public`, next to
  vocs's build-time artifacts (`llms.txt`, `llms-full.txt`).

## Workerd bridges (and why vocs is pinned exactly)

Upstream vocs only ships node/vercel/netlify adapters — nothing targets a
no-eval, no-fs runtime. Two seams needed fixture-side bridging, implemented as
the `workerdConfigBridge` vite plugin in `framework.ts`:

1. **Runtime config resolution** — vocs's server code calls
   `Config.resolve({ server: true })` per request; in production that branch
   dynamically imports an on-disk `dist/server/vocs.config.js` via
   `import.meta.dirname` (Node server layout), which crashes in workerd. The
   bridge rewrites that branch to import a virtual module carrying the
   config resolved once at build time in Node.
2. **`new Function` in the config deserializer** — vocs serializes
   config functions (`_vocs-fn_` markers; in this fixture only the default
   search `boostDocument`s) and revives them with `new Function`, which
   workerd forbids. The bridge makes revival fall back to `undefined` when
   code generation is disallowed; browser/Node paths still revive normally.

Both transforms hard-fail with a descriptive error if the installed vocs no
longer matches the expected internals — which is why `vocs` is pinned to an
exact version. On a bump, re-check the patterns in `framework.ts`.

`nodejs_compat` (not just `nodejs_als`) is required: vocs's server bundle
imports `node:fs` and friends (guarded with try/catch at runtime).

## Commands

```sh
bun run dev      # vocs dev over workerd (port 3105)
bun run build    # programmatic vocs build -> dist/ + dist/build.json
bun run preview  # miniflare over dist/build.json
bun run test     # playwright: live (built worker) + dev
```
