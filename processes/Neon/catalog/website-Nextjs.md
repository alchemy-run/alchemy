# Neon.Website.Nextjs

Initial status: **missing**. Runtime class: Node request/response framework adapted to Fetch. This is a **blocking feasibility target**, not an assumed supported wrapper. No actual runtime compatibility, build, local or browser test is recorded.

## Files and DX

`packages/alchemy/src/Neon/Website/Nextjs.ts`; `packages/frontend-frameworks/src/nextjs/neon.ts`; shared Node-to-Fetch adapter/staging under the assigned Website owner's scope; `packages/alchemy/test/Neon/Website/Nextjs.test.ts`; `examples/neon-website-nextjs`; JSDoc and guide.

Approved Prisma NextjsProps has shared framework-site options and no invented `nextjs` bag. Preserve rootDir/env/memo/assets/dev/scope/domain and restricted Function deployment controls; source next.config and plugins remain authoritative. Existing Prisma target uses `nextjs/node` with application-root `layout: "next"`; reuse safe trace/stage principles only.

## Feasibility and actual mapping

Current `nextjs/node.ts` creates a Node HTTP server and calls Next getRequestHandler; it cannot be uploaded unchanged to Neon. Produce an ESM index.mjs Fetch export that adapts real request/response streams and cancellation without binding/listening on a port. Stage .next server/runtime/static manifests/chunks, public files, required package scopes/dependencies and runtime config while excluding caches/source-only/secrets. Next image/native dependencies must be compatible with Neon Linux/Node24; no macOS binary copied from this workstation.

Live deployment is Function `getProjectBranchFunction`, `createProjectBranchFunctionDeployment` binary ZIP and matching active read, name PATCH as needed, delete. Implicit Project and optional CustomDomain lifecycle are shared, not direct Next control-plane APIs. Region/branch/slug identity rules and borrowed-scope/local-no-cloud rules are in websites.md. Changing code/env/config builds/deploys in place; unchanged deployment must remain stable.

## Exact G7 feasibility gate

Deploy actual Next production output to a real Neon Function. Prove pages/app routes, route handlers, server actions/forms, streaming, .next static assets, public images and image route, redirects/cookies and trusted custom-host reconstruction. Demonstrate package/file access and CJS/ESM/dynamic imports on Node24. next build, a listener running locally, or a generic Fetch hello world is not sufficient. If incompatible, capture an owned-fixture reproduction and report Nextjs blocked; do not replace its host or silently downgrade to static export.

## Completion matrix

Pass every shared Website gate plus browser submission of a server action that changes observable state, client navigation and hard refresh, cookie/session redirects on native/custom host, SSR 500 handling, HEAD/204 where applicable, stream backpressure/cancel and basePath asset/image paths. Confirm NEXT_PUBLIC_* browser values and exclude server-only secrets from assets/source maps. Unsupported image/native configuration must be explicit, not silently broken.

Local next dev HMR and env restart run behind RPC with absent cloud outputs/no implicit Project. Live update/no-op/destroy, remote dev opt-out, provider-mode deletion and supplied scope preservation must pass. Include desktop/mobile browser evidence and runnable guide/example; twice-clean scoped final rounds remain mandatory.
