# Neon.Website.ReactRouter

Initial status: **missing**. Runtime class: Fetch-native React Router SSR. Testability limited by executable dependencies/Function deployment; no implementation or live/browser result yet.

## Files and DX

`packages/alchemy/src/Neon/Website/ReactRouter.ts`; `packages/frontend-frameworks/src/react-router/neon.ts`; `packages/alchemy/test/Neon/Website/ReactRouter.test.ts`; `examples/neon-website-react-router`; JSDoc/guide. Approved Prisma wrapper adds no framework-specific option bag beyond shared Website props. Preserve react-router and Vite application config/plugins rather than inventing override fields.

## Artifact/lifecycle

Existing node target wraps the server manifest using React Router createRequestHandler and its entry defaults to `{ fetch }` (bare handler also supported), then adds serve-node.mjs. Neon target pins the Fetch handler instead, includes server manifest/chunks and client assets, and emits Node24 ESM index.mjs. No listening program, workerd bundle or S3 website.

Underlying SDK: getProjectBranchFunction/listProjectBranchFunctions; createProjectBranchFunctionDeployment ZIP; updateProjectBranchFunction name; deleteProjectBranchFunction. Optional implicit Project/domain use shared lifecycle. Scope/slug changes replace, content/env/config/assets update, no-op keeps deployment ID. Borrowed Project/Branch survives destruction; native dev owns no implicit Neon resources. Secrets/trace/stage policy follows websites.md.

## Required acceptance

All shared gates plus loader and action routes, form submit with validation error and success redirect, SSR/hydration, session cookie propagation, client nested navigation and deep hard refresh. Verify JS/CSS/images/manifests and base path, 404/error boundary/500, HEAD and deferred/streamed loader behavior with cancellation where supported. Form actions under custom host must see trusted origin correctly.

VITE_* public values are intentional; server-only/redacted/account-key sentinels excluded from client assets/maps and hydration payload. Native dev HMR/env changes and RPC cleanup; live update/no-op/destroy, remote opt-out/mode-safe deletion and preserved borrowed scope. Browser desktop/mobile actual typing/submission/navigation plus guide/example and two no-owned-leak rounds are mandatory.
