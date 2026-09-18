# Shared Website implementation and acceptance

All 13 constructors are mandatory and initially **missing**. Individual specs are `website-Vite.md`, `website-Astro.md`, `website-Nextjs.md`, `website-Nuxt.md`, `website-SvelteKit.md`, `website-ReactRouter.md`, `website-SolidStart.md`, `website-TanStackStart.md`, `website-Waku.md`, `website-Octane.md`, `website-Foldkit.md`, `website-Vocs.md`, `website-StaticSite.md`. A constructor is not complete because another target passed. Gate set G0–G3, G6–G10 plus per-framework cases.

## Files and ownership anchors

Implement public wrappers under `packages/alchemy/src/Neon/Website/`, export `Neon.Website` namespace, and Neon targets under `packages/frontend-frameworks/src/<framework>/neon.ts`. Use `packages/alchemy/src/Website/{Server,assets,packExtraFiles}.ts`, frontend-framework `core/{BuildOutput,NodeServe}.ts`, and the approved merged Prisma revision's `Prisma/Website/{FrameworkSite,Artifact}.ts`. Individual wrappers specify shared builders where a duplicate framework integration would be unnecessary (Foldkit uses Vite, StaticSite uses arbitrary command/output).

Prisma #1683 merged at the approved head `1503d1777d22a2a0e4dccbc3d59ae11c507412fa`; no broad main merge is required or authorized here. Its safe trace/stage implementation is a reference for dependency layout, not a Neon-ready archive or entrypoint. Keep Prisma tar.gz/Bun server behavior unchanged; Neon needs ZIP + Node24 Fetch. Shared extraction must regress all affected providers/framework paths.

## Shared props and outputs

| Prop | Default/type | Rules |
| --- | --- | --- |
| branch or project | optional exclusive common scope | Reuse supplied Project/Branch without ownership transfer; omitted scope creates an owned ordinary Neon Project on live deployment only. |
| rootDir | string; `.` | Framework app root; StaticSite preserves its cwd/outdir/command vocabulary. |
| env | supported string/redacted map | Build/dev/runtime as appropriate. Public prefixes compile into client assets; redaction does not make a public prefix secret. |
| memo | boolean or MemoOptions; true | Preserve framework/config/lockfile/output invalidation; no deployment for unchanged artifact/config. |
| assets | WebsiteAssetsProps | notFoundHandling none/single-page-application/404-page, htmlHandling none/drop-trailing-slash; served from Function origin. |
| dev | native framework/external-server options | Native HMR, no implicit Neon resources or production artifact in local path. |
| framework overrides | existing named option shape | Preserve project config/plugins; only inject the required Neon target behavior. |
| domain | optional hostname | Compose CustomDomain + existing DNS resources; expose CNAME before DNS wait; actual HTTPS separate. |
| function | restricted deployment-control bag | Website owns main/artifact/runtime wiring; reject conflicting entrypoint, unsupported memory/port/Dockerfile/Prisma promotion controls. |

Outputs: url, function, project/branch and domain; cloud-only outputs absent in native dev. Live omitted-scope Project keeps normal default database, unlike Prisma's database-less optimization. Combined-backend examples choose Ohio; a Function-supported default region must be verified before implicit creation. Changing resolved scope or Function slug replaces underlying Function; content/config/env updates deploy in place; domain identity changes follow CustomDomain conflicting-identity rules; changing local/live mode follows persisted engine mode dispatch. Referenced projects/branches survive Website destruction. An implicit owned Project is deleted only after owned Function/domain/credentials; local dev creates none.

## Actual SDK mapping for every wrapper

Wrappers use Alchemy Function provider, not raw management HTTP. Underlying APIs: `createProject`/`getProject`/`listProjectBranches` only for owned implicit scope; `getProjectBranchFunction`, `listProjectBranchFunctions`, `createProjectBranchFunctionDeployment` multipart ZIP, `updateProjectBranchFunction`, `deleteProjectBranchFunction`; optional `registerProjectBranchCustomDomain`, `listProjectBranchCustomDomains`, `deleteProjectBranchCustomDomain`. Framework builds/asset packaging are local Effect FileSystem/Command work, not SDK operations. No bucket, S3 website API, CDN or listening-server API appears in this composition.

## Feasibility gate before wrappers

Three separate **live** artifacts must first pass: packaged static-file Fetch handler; one Fetch-native SSR app; Next.js Node request/response-to-Fetch adapter. Assert on-disk file/dependency resolution, ESM/package scopes, redirects, streaming and custom-host reconstruction. Initial SDK ZIP string typing and absent Function host block these gates; do not count successful framework build as deployment proof. Runtime incompatibility must retain a reproduction and exact constructor blocker, not substitute another provider.

## Artifact contract

Production root has ESM index.mjs default Fetch export and every reachable runtime file. Do not deploy `serve-node.mjs` unchanged: existing Node targets listen on PORT. Fetch-native frameworks expose production handler and static assets. Node-listener frameworks use a tested streaming/cancellation-aware Node-request/response adapter, not a local proxy server hidden inside the Function.

Trace/stage preserves import.meta.url-relative paths, package.json scopes, pnpm dependencies, dynamic imports, runtime manifests and framework chunks. Use safe scoped staging and deterministic content hashing. Exclude .env variants, .alchemy, credentials/config files, source-only files and unsafe/unsupported native binaries. Reject traversal, escaping/cyclic symlinks, duplicate/absolute archive paths, excessive entries/bytes and unsupported artifacts before upload. Use verified Neon limits, not a copied Prisma upload allowance. No absolute developer machine paths in ZIP.

Asset handler preserves correct MIME, HTML no-cache policy, content-hashed caching, HEAD/bodyless responses, base paths, extensionless HTML, SPA versus 404 behavior and traversal protection. Server-only secrets and account credentials must not appear in JS/CSS/source maps or public outputs. Browser-prefixed values are deliberately public and must be tested, not merely wrapped in Redacted.

## Local and mode contract

Use Website.Server native dev with existing RPC-sidecar topology. Local hot reload/env restart and destroy must work without implicit Project/Branch/Function/domain/credential creation. Explicit Neon data resources remain live-only; bind those only when deliberately declared. `.pipe(Alchemy.remote())` on Website opts into real Function deployment during dev; test stamped deletion through mode switches, preserving supplied scope. Do not invent a Neon database/storage/auth emulator.

## Exact matrix required for each constructor

1. Build artifact with native source config/plugins and selected supported overrides; source config remains intact. Package dependency/static graph validated under Node24.
2. Native dev startup, HMR from code edit, env/config restart, no implicit cloud resources, correct absent cloud outputs, local cleanup through RPC sidecar.
3. Live deploy and fresh URL serving framework-specific routes/assets; update changes content/env; unchanged redeploy preserves deployment ID and skips build/upload.
4. Verify deep navigation + hard refresh, base path, JS/CSS/images, 404 and framework 500 where applicable, redirects, HEAD, forms/actions and streaming where applicable. No hello-world-only acceptance.
5. Verify build/runtime/public env boundaries including server-secret/account-key exclusion from browser asset/source-map scans; custom-host redirects/cookies/actions use trusted forwarded-host convention.
6. Browser desktop/mobile interaction: click, type, submit, navigate, refresh, shared state; rerun after fixes. Static apps use framework-appropriate navigation/form/API interaction rather than pretending SSR exists.
7. Live destroy and typed absence for owned Function/domain/implicit Project, with supplied Project/Branch preserved; two complete scoped no-leak rounds before completion. Explicit failures/skips remain per constructor.
8. Provide runnable `examples/neon-website-<framework>` plus guide and source JSDoc, with build/dev/deploy/destroy instructions. Framework version and required native build dependencies documented accurately.

Shared tutorial composes Vite frontend with Auth, storage, Functions, trigger and SQL. Its full browser flow is independent of optional paid AI; all 13 examples still remain required. Current live/build/browser/local verification count is zero for every constructor.
