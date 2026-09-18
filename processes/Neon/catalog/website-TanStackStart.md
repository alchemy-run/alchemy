# Neon.Website.TanStackStart

Initial status: **missing**. Runtime class: Fetch-native SSR. Testability limited until Function/runtime/dependency prerequisites pass; no build/local/live/browser result yet.

## Files and DX

Wrapper `packages/alchemy/src/Neon/Website/TanStackStart.ts`; target `packages/frontend-frameworks/src/tanstack-start/neon.ts`; suite `packages/alchemy/test/Neon/Website/TanStackStart.test.ts`; `examples/neon-website-tanstack-start`; JSDoc/guide. Preserve shared Website contract; approved Prisma wrapper adds no distinct framework bag. Source Vite/TanStack configuration remains authoritative and its plugins are preserved.

## Artifact and operation mapping

Current node target's server.js defaults to `{ fetch }` (bare function supported), then serve-node.mjs serves client files before it. Neon target selects this actual Fetch entry, stages server/client graph and exports index.mjs for Node24 without listen. Resolve external workspaces/package scopes and dynamic chunks correctly; no hidden local proxy server.

Use Function get/list/createProjectBranchFunctionDeployment ZIP/name PATCH/delete and optional Project/CustomDomain composition. Scope/slug change replaces; source/config/env/assets changes update; unchanged hash keeps deployment ID. Native dev creates no implicit Neon infrastructure; borrowed scope survives destruction; implicit owned Project is live-only and cleaned after dependents. Shared security/staging rules apply.

## Exact acceptance

All shared Website matrix gates plus SSR loader, server function call, interactive form/action, hydration and client state, nested navigation and hard refresh. Verify cookies/redirects, base path assets, 404/500, HEAD and streaming/cancellation supported by actual server entry. Prove server-function endpoint routing is not swallowed by static/SPA fallback.

Test public env compilation separately from server-only/redacted/account-secret exclusion from client assets/maps/serialized payloads. RPC dev HMR/env restart and cleanup, live update/no-op/destroy, remote opt-out and mode-safe deletion preserve supplied branch. Browser desktop/mobile typing/submitting/navigating after final fixes plus example/guide and two scoped zero-owned-leak rounds required.
