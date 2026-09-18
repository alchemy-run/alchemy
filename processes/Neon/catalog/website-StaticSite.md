# Neon.Website.StaticSite

Initial status: **missing**. Runtime class: arbitrary build command/output served by a Function Fetch asset handler. It is independently required from Vite. No build/local/live/browser results recorded.

## Files and DX

`packages/alchemy/src/Neon/Website/StaticSite.ts`, shared Neon artifact/static Fetch entry helper, `packages/alchemy/test/Neon/Website/StaticSite.test.ts`, `examples/neon-website-static-site`, JSDoc/guide. Reuse existing command/memo/dev primitives and Website assets semantics; there is no requirement to invent a frontend-framework SDK for arbitrary static generators.

Preserve approved StaticSite call vocabulary: cwd, command, outdir, env/memo, optional spa and errorPage, assets overrides, dev command with optional cwd/env/url, Neon scope/domain/restricted Function controls. Build output directory is distinct from application root; explain conflicts between spa/errorPage/assets settings consistently instead of silently overriding user configuration. Native dev uses the requested generator's server (e.g. Hugo), not a production deploy.

## Lifecycle and SDK mapping

Effect Command builds into outdir, fingerprints inputs/lockfile/output, then safe staging packages assets plus ESM index.mjs Fetch handler. No listening server or storage bucket. Underlying Function operations are get/list, createProjectBranchFunctionDeployment ZIP, updateProjectBranchFunction name, deleteProjectBranchFunction. Optional Project/CustomDomain use their existing scoped lifecycle. Validate output path boundaries, symlink/archive safety, MIME/cache policy and content hashes before upload.

Resolved scope/slug replace, command/output/files/env/routing configuration updates Function artifact; unchanged redeploy skips command/upload as memo permits. Native dev owns no implicit cloud resources and outputs no Function/Project/domain; explicit remote opts into live Function. Borrowed scope survives destroy; implicit owned live Project cleans after owned children. Static env intended for browser is public and server/account secrets must never be copied through arbitrary staging.

## Exact acceptance

All shared static Website matrix gates with a real non-Vite generator or deterministic static build command: multiple pages, JS/CSS/images/fonts, deep links/extensionless/trailing slash routing, configured errorPage (status 404), SPA toggle, base-path behavior, HEAD and cache/content type, traversal rejection and a real browser form/navigation control. Missing output/invalid dev command fail actionably; no fake server SSR claim.

Native generator dev edit/reload/env restart and RPC cleanup; no implicit cloud objects, remote opt-out/provider-mode deletion; live update/no-op/destroy with supplied Project preserved and own leaks absent. Browser desktop/mobile clicking/typing/submitting/navigation, separate example/guide and twice-clean scoped final rounds mandatory. Static packaging is one G7 feasibility probe but its success alone cannot complete the thirteen-target family.
