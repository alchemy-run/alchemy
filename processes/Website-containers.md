# Container Website (Fly, Hetzner, Railway)

1:1 of `Cloudflare.Website.*` and `AWS.Website.*` for the three container
platforms. Closer to Cloudflare in DX (one Service per site) than AWS
(S3 + CloudFront + Lambda).

**Repo:** `/Users/samgoodwin/workspaces/alchemy-effect-3`
**Branch:** `feat/container-websites` (from `origin/main`)

Do not implement on any other worktree. `cd` to that path first.

## Public DX

```ts
const site = yield* Fly.Website.Vite("Web", { app: Site });
const site = yield* Hetzner.Website.Vite("Web", { server });
const site = yield* Railway.Website.Vite("Web", { project: Site, registry });
```

Same composites on every platform:

| Composite | Cloudflare | AWS | Fly / Hetzner / Railway |
|---|---|---|---|
| Vite | Worker + assets | S3 + CloudFront (static) | Service serving `dist/` |
| Foldkit | Vite SPA defaults | — | Vite SPA defaults |
| Vocs | Worker + assets | — | Service serving static docs |
| StaticSite | Worker + outdir | S3 + CloudFront | Service serving `outdir` |
| Astro | Worker + adapter | Lambda + S3 | Service + node adapter |
| SvelteKit | Worker + adapter | Lambda + S3 | Service + node adapter |
| Nuxt | Worker + nitro | Lambda + S3 | Service + node/nitro |
| Octane | Worker + adapter | Lambda + S3 | Service + node adapter |
| Waku | Worker + adapter | Lambda + S3 | Service + node adapter |
| Nextjs | OpenNext CF | OpenNext AWS | `next build` + `next start` (Node) |

Skip AWS-only `Router` / `SsrSite` / CloudFront KV. Those are CloudFront
topology, not a framework.

Export as `export * as Website from "./Website/index.ts"` from each
platform `index.ts`.

## Architecture

### 1. Node deploy target (`@alchemy.run/frontend-frameworks/{fw}/node`)

A long-running Node/Bun HTTP target. **Not** workerd, **not** Lambda.

- `platform: "node"`
- `bundle.conditions`: `["node", "import", "module", "default"]` (no `workerd`)
- `bundle.external`: none of `cloudflare:` / `@aws-sdk/`
- `vitePlugins`: none (plain Node; frameworks drive their own build)
- `finish` (SSR frameworks): write a Node serve entry that
  1. serves `clientDirectory` as static files (`GET` assets first)
  2. falls through to the framework fetch/handler on `PORT` (default 3000)
  3. pins that file as `serverModules[0]`
- Vite / Vocs / static-only: no server modules; `clientDirectory` is the
  whole deployable output (AWS vite/aws.ts is the model)
- Next.js: `next build` then a serve entry that `import("next")` +
  `next({ dev: false }).prepare()` + `getRequestHandler()`, **or** spawn
  `next start` if that is more reliable. Do **not** use OpenNext AWS/CF
  wrappers — those are Lambda/workerd. Container-optimal is Node `next start`.
- Astro `output: "static"`: drop `serverModules` (same as AWS astro/aws
  `finish`).
- Reuse `runBuildChild` so the engine process never `chdir`s.

Add matching `package.json` `exports` and `tsdown.config.ts` `entry` keys
(`astro/node`, `vite/node`, …). Mirror `./astro/aws` export shape.

### 2. `makeContainerFrameworkSite` (per platform)

Copy `AWS.Website.FrameworkSite` *shape*, not CloudFront:

1. `AlchemyContext.dev && !Alchemy.remote()` → framework `dev` server,
   return `{ url }` with no cloud resources (AWS pattern).
2. Else load framework module + node target via specifier strings
   (structural typing like `AWS.Website.Server`).
3. `build()` → `{ clientDirectory, serverModules }`.
4. Deploy one platform **Service**:
   - `main` = generated Node/Bun serve entry (or a tiny static-file
     server when there are no server modules)
   - bake `clientDirectory` into the image (Docker `COPY` / hosted
     `install` / `build` assets — use each platform's existing Service
     image pipeline)
   - `PORT=3000`
5. Identity:
   - **Fly:** `app` required or auto `Fly.App`; `IpAssignment` shared_v4
     so `{app}.fly.dev` answers; `url` is `https://{appName}.fly.dev`
   - **Hetzner:** `server` required or auto-create a cheap CX22 +
     Primary IP in `fsn1`; Service on that server; `url` is `http://{ipv4}`
     (https only if Certificate/LoadBalancer already exist — do not
     invent ACME for v1 unless DNS props are passed)
   - **Railway:** `project` required or auto `Railway.Project`; Service
     with `registry` (skipIf-gate live tests without `RAILWAY_REGISTRY`);
     `url` is `https://{domain}`
6. Optional `domain` string: Fly certificate / Hetzner RecordSet on
   existing Zone / Railway CustomDomain. Keep v1 minimal: document
   required existing DNS zone/app.

During `alchemy dev`, `url` is the local framework URL. `Alchemy.remote()`
opts into the live Service path (ProviderMode doctrine).

### 3. StaticSite / Foldkit / Vocs

- **StaticSite:** `command` + `outdir` like Cloudflare/AWS; deploy the
  outdir as a static-file Service. `dev.command` for local.
- **Foldkit:** Vite composite with SPA `notFoundHandling` default
  (Cloudflare.Website.Foldkit).
- **Vocs:** static docs via vocs node target (Cloudflare vocs is the
  model).

### 4. Tests (same standard as Cloudflare/AWS)

Co-locate under `packages/alchemy/test/{Fly,Hetzner,Railway}/Website/`.

Reuse Cloudflare fixtures by cloning (`cloneFixture`) — do **not** fork
giant fixture trees unless a platform entry file is required.

Minimum per platform (live `--profile testing`, `timeout` 90–120s,
`stack.destroy()` start and end, deterministic names):

1. Vite SPA: deploy, GET `/` 200, destroy, gone
2. StaticSite: build command + outdir, GET index
3. One SSR framework (Astro or SvelteKit): GET `/` 200 and one
   dynamic/API route
4. `{Resource}.local.test.ts` for Vite: `Test.make({ dev: true })` —
   `url` is localhost, no cloud identity

Railway docker-push tests: `skipIf(!canPushRailwayImage)` (existing
helper). Hetzner: concurrency 2, quota-aware. Fly: default concurrency.

Do **not** run `tsc`/`pnpm build` inside implementer agents.

### 5. Examples

`examples/{fly,hetzner,railway}-website-vite/` modeled on
`examples/aws-website-vite` / `examples/cloudflare-website-*`:
`alchemy.run.ts`, `integ.test.ts`, README, package.json.

### 6. Shared-file discipline

Only the owning agent touches:

- `packages/frontend-frameworks/package.json` + `tsdown.config.ts`
  (node-target agent)
- `packages/alchemy/src/Fly/index.ts` (Fly agent) — one
  `export * as Website from "./Website/index.ts"`
- same for Hetzner and Railway
- Do not rewrite `Providers.ts` unless a new Resource type needs a
  provider. Website composites should compose existing Service/App/
  Project/Server providers.

### 7. JSDoc

`@resource` / `@section` / `@example` on every exported Website
composite. Field JSDoc on props. `pnpm docs:fix-jsdoc` at the end.
Never edit generated `website/src/content/docs/providers/**`.

## Reference files (read these)

- `packages/alchemy/src/Cloudflare/Website/{Vite,Astro,StaticSite,index}.ts`
- `packages/alchemy/src/AWS/Website/{FrameworkSite,Server,Vite,Astro,StaticSite}.ts`
- `packages/frontend-frameworks/src/{vite,astro,waku}/{aws,cloudflare}.ts`
- `packages/frontend-frameworks/src/core/DeployTarget.ts`
- `packages/frontend-frameworks/tsdown.config.ts`
- `packages/alchemy/src/{Fly,Hetzner,Railway}/Service.ts`
- `packages/alchemy/test/Cloudflare/Website/Vite.test.ts`
- `packages/alchemy/test/AWS/Website/` (if present)
- `AGENTS.md` Reconciler + test + JSDoc doctrine
