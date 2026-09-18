# Neon.Website.Nuxt

Initial status: **missing**. Runtime class: Nitro server output adapted to Neon Fetch. Testability limited by dependencies, Function binary deployment and adapter feasibility; no runtime/local/browser evidence yet.

## Files and DX

Wrapper `packages/alchemy/src/Neon/Website/Nuxt.ts`; target `packages/frontend-frameworks/src/nuxt/neon.ts`; tests `packages/alchemy/test/Neon/Website/Nuxt.test.ts`; example `examples/neon-website-nuxt`; JSDoc/guide. Preserve shared Website props plus `nuxt?: Record<string, unknown>`, matching approved Prisma wrapper. User Nuxt modules/plugins and runtimeConfig remain intact; report conflicting deployment preset instead of overwriting the config wholesale.

## Production strategy and SDK mapping

Assessed `nuxt/node.ts` selects Nitro's `node` listener preset and node-listener runtime handler. That listener isn't a Fetch export. Neon target must use a verified Fetch-compatible Nitro output or the shared tested Node-request/response adapter, then package .output server/public assets with ESM index.mjs. Do not run `serve-node.mjs`, listen on PORT or ship Cloudflare runtime modules. Verify actual framework-version Nitro handler contract before choosing its entrypoint.

SDK operations are underlying Function get/list → createProjectBranchFunctionDeployment ZIP → active deployment read → name PATCH → delete. Optional owned implicit Project and CustomDomain use their cataloged operations. Project/branch/slug replace; framework/code/env/assets change updates in place; no-op skips deployment. Supplied scope isn't owned. Native Nuxt dev produces local URL and no implicit Neon infrastructure.

## Required acceptance

Pass shared Website matrix: SSR page with server data, Nitro API route, client hydration/navigation, form POST/redirect/cookies, dynamic/deep route hard refresh, CSS/JS/images, baseURL, 404/500, HEAD and supported streaming/cancellation. Production tests must fetch real .output assets and server chunks under Neon Node24; build-only is insufficient.

Public runtimeConfig/NUXT_PUBLIC_* data is intentionally browser-visible; private runtimeConfig, redacted values and NEON_API_KEY absent in browser payload/assets/maps. Custom-host URL reconstruction must preserve auth/redirect behavior without trusting arbitrary forwarded headers. Native dev/HMR/env restart and RPC cleanup; live update/no-op/destroy, remote opt-out and supplied-project preservation. Browser desktop/mobile form interaction plus example/guide and twice-clean owned census required.
