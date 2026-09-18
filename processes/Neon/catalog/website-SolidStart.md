# Neon.Website.SolidStart

Initial status: **missing**. Runtime class: SolidStart SSR through Nitro/Node or verified Fetch output. Testability limited until actual adapter, Function ZIP and dependencies pass. No build/dev/live/browser verification yet.

## Files and DX

Wrapper `packages/alchemy/src/Neon/Website/SolidStart.ts`; target `packages/frontend-frameworks/src/solidstart/neon.ts`; `packages/alchemy/test/Neon/Website/SolidStart.test.ts`; `examples/neon-website-solidstart`; JSDoc/guide. Preserve shared Website props plus `nitro?: Record<string, unknown>` exactly as approved Prisma wrapper. Do not replace with a newly invented top-level solidstart shape at the Website call site. Preserve source config/plugins and existing builder option conversion.

## Production strategy/mapping

Current integration builds via Solid's Vite/Nitro plugin and node target selects Nitro `node` listener. Neon requires a verified Fetch-compatible Nitro output or shared tested Node-to-Fetch adapter; never deploy the listener itself. Reuse build/config discovery, package server/public graph and ESM index.mjs with no PORT/listen or workerd runtime. Conflicting Nitro presets are actionable configuration errors.

Function get/list → createProjectBranchFunctionDeployment ZIP → matching active state → name PATCH → delete is the actual control-plane path. Optional Project/domain are shared composites, not framework APIs. Scope/slug replace; code/env/Nitro/assets update in place; no-op avoids upload. Implicit Project only live, supplied scope never transfers ownership, native dev creates none.

## Exact acceptance

Pass shared matrix plus real SSR data route, server function/action or form submission, hydration/state changes, redirects/cookies, client navigation/deep refresh, base-path JS/CSS/images, 404/500/HEAD and supported streaming/cancellation. Verify actual deployed Nitro/server chunks resolve on Node24, not only a successful build.

Public Vite/framework env is intentional; server-only/redacted/account credentials excluded from assets/source maps/serialized page data. Native dev HMR/env restart behind RPC and cleanup, remote opt-out/provider-mode delete, live update/no-op/destroy with borrowed branch retained. Browser desktop/mobile forms/navigation plus guide/example and two scoped no-leak rounds are mandatory; an incompatible Nitro output is an explicit SolidStart blocker, not an accepted substitute host.
