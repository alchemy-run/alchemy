# Neon.Website.Waku

Initial status: **missing**. Runtime class: Waku React Server Components/Fetch server with prerendered assets. Testability limited until exact Node24 runtime graph and Function deployment pass; no validation recorded.

## Files and DX

`packages/alchemy/src/Neon/Website/Waku.ts`; `packages/frontend-frameworks/src/waku/neon.ts`; `packages/alchemy/test/Neon/Website/Waku.test.ts`; `examples/neon-website-waku`; source JSDoc/guide. Shared Website options plus `waku: { srcDir?, distDir?, basePath? }` match approved Prisma DX. Default extensionless HTML handling is drop-trailing-slash; user assets override remains supported.

## Production/lifecycle

Existing node target selects the project's waku/adapters/node and finishes with a Node listener around a Fetch handler. Inspect the installed Waku version's actual adapter server export; Neon target must retain its RSC/dynamic routes and required manifests without starting the listener. Package prerendered/client/server chunks with ESM index.mjs, correct package scopes and dynamic import layout. Native application Waku config/plugins remain intact.

Actual APIs: Function get/list/createProjectBranchFunctionDeployment ZIP/updateProjectBranchFunction/deleteProjectBranchFunction plus shared optional owned Project and CustomDomain operations. Scope/slug replace; source/env/Waku/base/assets update in place; no-op does not upload. Native Waku dev creates no implicit Neon resources; referenced Project/Branch stays borrowed. No S3 website hosting/CDN claim.

## Exact acceptance

Shared Website matrix plus server-rendered route and a client interaction consuming RSC/server response, RSC navigation/refresh, prerendered page, form/server action where supported by pinned framework and dynamic route data. Verify JS/CSS/images and RSC chunks, extensionless/trailing slash/basePath routing, 404/500, HEAD, redirects/cookies and streamed RSC cancellation. A static homepage cannot prove RSC compatibility.

Public Waku/Vite environment values are intentional; server-only/account/redacted secrets absent from client graph/maps and RSC payloads. Native dev/HMR/env restart and RPC cleanup; live update/no-op/destroy, remote opt-out/mode deletion and borrowed-scope preservation. Browser desktop/mobile interaction and example/guide mandatory; shared Waku/Vocs staging changes need regression checks for both and other providers. Two no-owned-leak rounds required.
