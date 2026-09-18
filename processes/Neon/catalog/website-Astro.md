# Neon.Website.Astro

Initial status: **missing**. Runtime classes: Fetch-native SSR and static/prerendered output. Testability: limited until shared prerequisites and a live Fetch SSR artifact pass. No local/build/live/browser tests ran.

## Files and DX

Wrapper `packages/alchemy/src/Neon/Website/Astro.ts`; target `packages/frontend-frameworks/src/astro/neon.ts`; tests `packages/alchemy/test/Neon/Website/Astro.test.ts` with local/RPC fixtures; example `examples/neon-website-astro`; JSDoc and guide.

Preserve shared Website props plus `astro: { site?, base?, output?: "server" | "static", srcDir?, publicDir?, outDir?, trailingSlash?: "always" | "never" | "ignore" }`. Use approved Prisma wrapper vocabulary and existing Astro build/integration code. Default not-found handling is none; static/custom 404 behavior is explicit. Preserve React/MDX/Tailwind/user integrations, and reject conflicting adapters actionably instead of replacing the source config.

## Production/lifecycle

Current `astro/node.ts` already constructs an Astro App.render Fetch entry but finishes with a listening Node program. Neon target selects the Fetch server entry directly, includes emitted manifest/server chunks + client/prerendered assets, and wraps only static origin routing as necessary. Static output skips a fictional server graph; both forms still use Function Fetch deployment.

Actual management mapping: Function get/list, createProjectBranchFunctionDeployment ZIP, updateProjectBranchFunction for name, deleteProjectBranchFunction; Project only for implicit owned scope, optional CustomDomain register/list/delete. Scope/slug changes replace; content/config/output/base changes update artifact in place. Reference scope is borrowed; no implicit scope in native dev. Archive/package safety and server-secret exclusion follow websites.md.

## Required acceptance

All shared Website gates plus both output modes: actual SSR page uses request/query/cookie data, endpoint/form route behaves correctly, static prerender loads under base path, islands hydrate and support interactive browser changes. Verify redirects, 404/500, trailingSlash behavior, CSS/JS/images/MDX assets, HEAD and streamed responses where framework supports them.

Use PUBLIC_* only for intentionally public build values; prove server-only and redacted sentinels absent from browser assets/maps. Live SSR file/dependency resolution qualifies for G7 only if actual deployed page and stream work. Native Astro dev/HMR uses RPC sidecar, emits no implicit cloud resources, and cleans up. Live update/no-op/destroy and borrowed-scope preservation pass twice with owned leak census. Browser desktop/mobile interaction and guide/example are mandatory.
