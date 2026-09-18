# Neon.Website.Vite

Initial status: **missing**. Runtime class: static assets / SPA from a Neon Function. Testability: limited until root dependencies, Function ZIP transport, Node24 asset handler and authorized live scope pass. No local/build/live/browser evidence yet.

## Files and exact DX

- Wrapper: `packages/alchemy/src/Neon/Website/Vite.ts` + namespace export.
- Framework target: `packages/frontend-frameworks/src/vite/neon.ts`; reuse `vite/index.ts` build/dev abstraction, not `vite/node.ts`'s listening serve entry.
- Test: `packages/alchemy/test/Neon/Website/Vite.test.ts` and local/RPC fixture coverage.
- Runnable example: `examples/neon-website-vite`; source JSDoc + Website guide.
- Reference: Prisma Website/Vite.ts at merged approved head. Props preserve shared `rootDir`, `env`, `memo`, `assets`, `dev`, optional scope/domain/restricted function controls; `vite: { outDir?, base? }`. Default routing is SPA, overrideable with assets.notFoundHandling.

## Build and lifecycle mapping

Vite outputs an assets-only BuildOutput. Generate ESM index.mjs exporting Fetch with packaged output directory; no fake SSR server. Preserve application Vite plugins, base/public paths, configured output and lockfile hashing. Build/dev config is native Vite; deploy origin serves HTML/assets through Function.

Use Function `getProjectBranchFunction` → `createProjectBranchFunctionDeployment` multipart ZIP → matching active deployment read → optional name PATCH → `deleteProjectBranchFunction`; implicit owned scope only uses Project creation, optional domain uses CustomDomain list/register/delete. No storage bucket or CDN API. Exact shared lifecycle is `websites.md`.

Identity: project/branch/Function slug replace; file/env/assets/base configuration updates build/artifact and Function in place; no-op preserves deployment ID. Native dev creates no implicit Neon objects. Supplied scope survives destroy; implicit owned Project is cleaned after Function/domain. Public VITE_* values are browser-visible, including a mistakenly redacted value under that prefix; never copy server-only env/account key into assets.

## Required acceptance

Pass every shared Website matrix step and G7 static feasibility. Test client navigation, refresh nested routes, base-path CSS/JS/image imports, SPA fallback versus explicit 404-page override, HEAD, content-type/cache headers, traversal rejection and form/API interaction from the browser. Build-time VITE_API_URL/VITE_AUTH_URL appear as intended; server secret sentinels absent from JS/source maps.

Native dev HMR and env restart work behind RPC and report no cloud-only outputs. Live update changes content, unchanged redeploy creates no deployment, cleanup leaves no owned Function/domain/implicit Project and preserves supplied branch. Browser desktop/mobile click/type/submit/navigation is required, not only HTTP 200. Vite is the flagship upload/Auth tutorial frontend, whose complete sign-in/upload/status/download/sign-out flow remains an additional aggregate gate.
