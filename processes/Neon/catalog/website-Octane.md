# Neon.Website.Octane

Initial status: **missing**. Runtime class: Node-target Octane Fetch handler. Testability limited until entrypoint auto-listen suppression and real Neon runtime are verified. No build/local/live/browser pass recorded.

## Files and DX

Wrapper `packages/alchemy/src/Neon/Website/Octane.ts`; target `packages/frontend-frameworks/src/octane/neon.ts` and adapter marker only if required by existing integration; tests `packages/alchemy/test/Neon/Website/Octane.test.ts`; example `examples/neon-website-octane`; JSDoc/guide. Approved Prisma wrapper uses shared Website props with no extra Octane bag. Preserve application's @octanejs/vite-plugin and octane.config; diagnose mismatched adapter rather than wholesale replacing config.

## Build and mapping

Current node target emits entry.js exporting web-standard Fetch handler and suppresses Octane isMainModule auto-listen when flattening bundles. Neon target must preserve that suppression while exporting index.mjs; reusing a flattened listener is not safe. Stage server/client files and CJS/ESM dependencies for Node24, with native-runtime boundary checks. Retain native development behavior without cloud creation.

SDK mapping: Function get/list, createProjectBranchFunctionDeployment ZIP, updateProjectBranchFunction name, deleteProjectBranchFunction; optional shared owned Project and CustomDomain register/list/delete. Project/branch/slug replace; code/config/env/assets update, unchanged deployment stable. Referenced scope survives destroy and implicit Project exists only live. Shared archive/secret/ownership requirements apply.

## Exact acceptance

All Website matrix steps plus actual Octane server-rendered/dynamic route, client hydration and framework-appropriate form/action, navigation/refresh, base-path assets, 404/500, HEAD, redirects/cookies and supported streaming/cancellation. Assert deployed entry exports Fetch and opens no HTTP listener; Node24 entry imports work with generated package layout.

Browser-public Vite/framework env verified and server-only/redacted/account values excluded from assets/maps/page state. Native dev HMR/env changes behind RPC and cleanup, live update/no-op/destroy, remote opt-out/provider-mode deletion and preserved borrowed branch. Browser desktop/mobile submit/navigation, example/guide and two clean scoped owned-resource rounds required. If framework runtime prevents Fetch deployment, keep this constructor explicitly blocked with reproduction.
