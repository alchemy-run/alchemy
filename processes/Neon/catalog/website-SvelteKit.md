# Neon.Website.SvelteKit

Initial status: **missing**. Runtime class: Fetch-native SSR plus prerendered/client assets. Testability limited until Function/static/SSR feasibility and dependencies pass. No test or browser pass recorded.

## Files and DX

Wrapper `packages/alchemy/src/Neon/Website/SvelteKit.ts`; target `packages/frontend-frameworks/src/sveltekit/neon.ts`; suite `packages/alchemy/test/Neon/Website/SvelteKit.test.ts`; example `examples/neon-website-sveltekit`; JSDoc and guide. Shared Website options plus `kit?: Record<string, unknown>` match merged Prisma vocabulary. Preserve source Svelte/Vite configuration and plugins; choose the Neon adapter contract deliberately instead of overwriting application config.

## Build and lifecycle

Existing sveltekit/node uses an in-memory Kit adapter to emit server graph and unbundled Fetch handler, then a finishing pass wraps a listening Node server. Reuse Kit build/config logic, select the actual Fetch entry, stage generated manifest/server graph/client/prerendered files and export Node24 ESM index.mjs without listen. Preserve server runtime package scopes and base/assets paths.

Actual operations: Function get/list, createProjectBranchFunctionDeployment multipart ZIP, updateProjectBranchFunction display name, deleteProjectBranchFunction; optional Project/CustomDomain composition. Scope/slug identity replaces; kit/config/code/env changes update artifact/deployment, no-op keeps ID. Borrow supplied scope, create implicit Project only live, and delete only owned children/implicit scope. Shared archive/security rules apply.

## Exact acceptance

All shared matrix gates plus SSR load data, endpoint routes, form actions with browser progressive enhancement, cookies and redirects, client navigation + deep refresh, prerendered pages and hydrated components. Verify base paths, assets/public files, HEAD, 404/500 and streaming/cancellation supported by actual Kit handler. Test action origin checks using native and authorized custom host.

PUBLIC_* is public; server `$env`/redacted/account credentials never appear in client assets or maps. Native Kit dev HMR and env restart work through RPC without implicit Neon creation. Live update, unchanged deploy, cleanup, remote opt-out/provider-mode deletion and preserved borrowed branch must pass; browser desktop/mobile forms/navigation after final fixes, runnable example/guide and two clean scoped rounds are required.
