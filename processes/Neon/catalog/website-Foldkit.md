# Neon.Website.Foldkit

Initial status: **missing**. Runtime class: client-only Foldkit/Vite SPA from Function assets. This constructor is independently required even though it shares the Vite builder. No local/build/live/browser evidence yet.

## Files and DX

`packages/alchemy/src/Neon/Website/Foldkit.ts`; reuse `packages/frontend-frameworks/src/vite/neon.ts` rather than invent a duplicate Foldkit framework SDK; `packages/alchemy/test/Neon/Website/Foldkit.test.ts`; `examples/neon-website-foldkit`; JSDoc/guide. Approved Prisma implementation delegates to Vite and extends ViteProps, setting single-page-application fallback while allowing user assets overrides. Preserve `vite: { outDir?, base? }` plus shared scope/rootDir/env/memo/dev/domain/function options.

## Build/lifecycle

The project's Foldkit Vite plugin drives real build/dev. Package Vite output and a safe Node24 Fetch asset entry; no fictional SSR or independent Foldkit server API. Observe/build fingerprints and use underlying Function get/list/createProjectBranchFunctionDeployment ZIP/name PATCH/delete. Implicit owned Project and optional CustomDomain compose normally. No S3 website/CDN.

Scope/slug changes replace; app/code/config/assets/env update existing Function; no-op preserves deployment ID. Native dev/HMR creates no implicit Neon infrastructure and cloud outputs are absent. Borrowed Project/Branch remains untouched on destroy; implicit owned live scope is deleted after owned children. Browser VITE_* is public, not protected by Redacted.

## Exact acceptance

Pass all shared static/SPA matrix gates with an actual Foldkit app, not the Vite example counted twice: component state/input/form interaction, client route navigation and deep hard refresh, base path, CSS/JS/images, SPA fallback and explicit 404-page override, HEAD, redirects where configured and traversal protection. A framework-appropriate API/form integration proves interaction, while server 500/SSR is not falsely claimed for a static app.

Verify public env works and server/account secrets absent in assets/maps. Native dev Foldkit HMR/env restart/RPC cleanup; live update/no-op/destroy, remote mode behavior and supplied-scope preservation. Browser desktop/mobile click/type/submit and layout, separate runnable example/guide and two clean owned-resource rounds required.
