# Neon.Website.Vocs

Initial status: **missing**. Runtime class: Vocs documentation application on Waku-backed Fetch output plus prerendered assets. Testability limited until pinned Vocs/Waku output and Node24 packaging pass; no validation yet.

## Files and DX

Wrapper `packages/alchemy/src/Neon/Website/Vocs.ts`; target `packages/frontend-frameworks/src/vocs/neon.ts`; tests `packages/alchemy/test/Neon/Website/Vocs.test.ts`; `examples/neon-website-vocs`; JSDoc/guide. Preserve shared Website props plus `outDir?: string`, matching approved Prisma wrapper. Default htmlHandling is drop-trailing-slash. Preserve source docs/Vocs config and plugins; do not replace it with an unrelated Vite SPA configuration.

## Production/mapping

Assessed vocs/node builds in child process using the installed Waku Node adapter and a Fetch handler but wraps it in serve-node.mjs. Neon target retains the Fetch handler, documentation routing, prerendered output, server/RSC graph and client/search assets, exporting Node24 ESM index.mjs with no listener. If configured output is purely static, keep its docs-route behavior but do not discard required runtime routes based on assumption.

Control plane is Function get/list/createProjectBranchFunctionDeployment ZIP/name PATCH/delete with shared optional implicit Project and CustomDomain list/register/delete. Scope/slug change replaces; docs/config/env/assets update; unchanged build/deployment stable. Native Vocs dev creates no implicit Neon resources; supplied scope is borrowed and preserved on cleanup. Archive safety and public/server secret separation follow websites.md.

## Exact acceptance

Shared Website matrix plus multi-page docs/sidebar navigation, search or another real interactive docs control, deep-link hard refresh, anchors, markdown/MDX component hydration, CSS/fonts/images, base path, extensionless/trailing slash behavior and custom 404. Exercise any emitted dynamic/RSC routes instead of treating every Vocs version as static. Verify HEAD/redirects, applicable SSR 500/stream cancellation and custom-host reconstruction.

Public build env deliberately visible, account/server/redacted values absent from maps/assets/RSC payloads. Native dev docs edit/HMR/env restart/RPC cleanup, live docs update/no-op/destroy, remote opt-out/mode-safe deletion and borrowed-scope retention. Browser desktop/mobile sidebar/search/input/navigation plus dedicated example/guide and two scoped no-owned-leak rounds required. Regress shared Waku staging if extracted.
