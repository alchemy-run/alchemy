# Parity with `@cloudflare/vite-plugin`

Alchemy's Vite plugin replaces `@cloudflare/vite-plugin` (checked against
**2.0.0-rc.1**, the catalog version). Frameworks are built against the official
plugin's behavior, so anything they can observe must match. This file is the
inventory of that surface: every behavior is **matched** (with the test that
pins it), **different on purpose** (with the reason), or **out of scope**.

Configuration and deploy tooling are out of scope: Alchemy configures Workers
in code and deploys them itself, so `cloudflare.config.ts` and `wrangler.json`,
`.dev.vars`/`.env` secret loading, Build Output and `cf deploy`, generated
Worker types (`.cloudflare/types`), deploy config redirects, tunnels, the
development registry, keyboard shortcuts, agent hints, update checks and the
local explorer/observability UIs have no counterpart.

### Tracking v2

Upstream develops v2 on `main`; v1 (`1.x`, on the `vite-plugin-v1` branch)
only gets maintenance releases, so the catalog tracks v2's prerelease line.
Most of v2 is how a project is configured and deployed: native
`cloudflare.config.ts`, Build Output in `.cloudflare/output/v1` for
`cf deploy`, no Wrangler. Alchemy uses none of that, so it is out of scope
above and nothing here changes because of it. What frameworks observe (the
resolved Vite config, what each environment emits, the dev server) is
compared with v2 as before. The differences that remain are listed below with
their reasons; search for "v2" to find them.

## How parity is enforced

| Test | What it checks |
| --- | --- |
| [`test/parity/config.test.ts`](./test/parity/config.test.ts) | Resolves one project with both plugins (`serve` and `build`, with and without `nodejs_compat`/`nodejs_als`, with user overrides, in production) and compares what frameworks read: each environment's `resolve`, `define`, `build`, `optimizeDeps`, the client environment, `appType`, `server.fs.deny`. |
| [`test/parity/build.test.ts`](./test/parity/build.test.ts) | Builds eight project shapes with both plugins and compares what each environment emits (client and Worker files, entry chunk exports). v2's Build Output directories are compared with the `dist/` directories they replace (see Build). |
| [`test/parity/constants.test.ts`](./test/parity/constants.test.ts) | Compares the runtime pieces ported verbatim (handler keys, additional module rules, `cloudflare:*` built-ins, Sandbox preview origins) with the installed release. v2 states module rules as `@cloudflare/config` globs, so the test checks each glob's file resolves to the same module type. |
| `packages/integration-tests/test/Cloudflare/Website/Vite*.test.ts` | The plugin's playgrounds and create-cloudflare's templates, deployed and under `alchemy dev`. |

Upgrading `@cloudflare/vite-plugin` in the catalog re-runs all three
differential tests against the new release, so upstream drift in config,
build output or the ported runtime fails CI here instead of in an app.
Fixes ported from upstream `main` before a release ships them are listed in
[`test/parity/ahead-of-release.ts`](./test/parity/ahead-of-release.ts), which
the differential tests ignore until the installed release catches up.

## Inventory

### Plugin identity and options

| Behavior | Status | Test |
| --- | --- | --- |
| Frameworks detect the plugin by a `vite-plugin-cloudflare` name prefix (React Router, vinext, Vike's `@universal-deploy`, Flue) | Matched (`vite-plugin-cloudflare:alchemy`) | `plugin-name.test.ts` |
| An official `cloudflare()` left in the config (or added by an async factory, e.g. RedwoodSDK) is neutralized | Matched | `plugin-name.test.ts`, `ViteTemplates.test.ts` |
| The `config` customizer of a neutralized `cloudflare()` still runs (Flue's `flueWorkerConfig()`). In v2 it is a callback over the loaded `cloudflare.config.ts`, and it runs without that file | Matched, against the installed release | `plugin-name.test.ts`, `examples/cloudflare-flue` |
| v2 with a leftover `wrangler.json`/`wrangler.jsonc` and no `cloudflare.config.ts` | Different: v2 rejects the project before calling the customizer, so a customizer (Flue) doesn't run. That is v2's own migration step (it fails the same way without Alchemy), so Alchemy doesn't work around it; the project still builds with Alchemy's plugin | `plugin-name.test.ts` |
| `rsc: { serverHandler: false }` for `@vitejs/plugin-rsc` | Matched | React Router RSC fixtures |
| Worker settings from `cloudflare.config.ts` (v2) or `wrangler.json` (v1), and the customizer's result | Different: declared on the Website resource | — |
| `auxiliaryWorkers`, `persistState`, `remoteBindings`, `inspectorPort` | Different: separate `Cloudflare.Worker` resources, Alchemy state, `Alchemy.remote()` | — |
| `assetsOnly`, `tunnel`, `types` (v2) | Out of scope: the deploy shape, tunnels and type generation are Alchemy's own | — |
| `prerenderWorker` (stable in v2) | Out of scope: Alchemy prerenders through the preview server, which is matched | `ViteBuild.test.ts` |

### Resolved config

| Behavior | Status | Test |
| --- | --- | --- |
| `appType: "custom"`; `server.fs.deny` (Vite's, credentials, key stores, `.wrangler`) | Matched, plus Alchemy's state and stack files | `config.test.ts`, `ViteRuntime.test.ts` (sensitive files) |
| Worker environment `resolve` (conditions, `noExternal`, built-ins) | Matched | `config.test.ts` |
| `cloudflare:durable-objects` is a runtime built-in | Matched | `constants.test.ts`, `config.test.ts` |
| `define`: `process.env.NODE_ENV`; `process.env` as `{}` without `nodejs_compat` | Matched | `config.test.ts`, `ViteRuntime.test.ts` (NODE_ENV) |
| `build`: target (`es2026` on Rolldown), `cssTarget` (only when the user sets none), no manifest, source maps, `emitAssets`, `copyPublicDir`, `ssr`, `index` entry input | Matched | `config.test.ts`, `build.test.ts` |
| `build.outDir` | Different: Alchemy keeps Vite's `<outDir>/<environment>` (`dist/ssr`, `dist/client`) and honors a user's `build.outDir`. v2 points every environment into Build Output and ignores `build.outDir`. Alchemy deploys from Vite's layout, and frameworks and Alchemy's Website resources read it | `config.test.ts` (keeps Vite's output directories) |
| `optimizeDeps`: entries, `development` condition, Node.js and `cloudflare:*` excluded | Matched | `config.test.ts` |
| esbuild `supported.using` scoped to Worker environments (Vite 6/7) | Matched | `config.test.ts` (Rolldown); code path mirrors upstream |
| Assets-only projects declare no Worker environments | Matched | `config.test.ts`, `build.test.ts` |

### Build

| Behavior | Status | Test |
| --- | --- | --- |
| Default `buildApp`: Worker environments, then the client; a client with no entry builds for `public/` or Worker-imported assets; assets the entry Worker and its built children import move to the client output | Matched | `build.test.ts` |
| A user's own `buildApp` is kept; afterwards the Worker environments and client it left out build and imported assets move | Matched | `build.test.ts`, `ViteRuntime.test.ts` (custom buildApp) |
| Additional modules (`.wasm`, `.bin`, `.txt`, `.html`, `.sql`, subpath imports), `.wasm?init` | Matched | `build.test.ts`, `ViteRuntime.test.ts` (additional modules) |
| Node.js compat: unenv aliases, injected globals and polyfills | Matched | `ViteNodeCompat.test.ts` |
| Unexpected Node.js imports warn without `nodejs_compat` (build and dev) | Matched | `dev-plugin.test.ts`, `ViteNodeCompat.test.ts` (als) |
| `using` kept native | Matched | `build.test.ts`, `ViteBuild.test.ts` |
| Deployed modules are the output as written to disk; `.vite/` metadata isn't deployed | Matched | `ViteTemplates.test.ts` (Vike) |
| Build Output (v2): the client in `.cloudflare/output/v1/workers/default/assets`, the Worker in `…/bundle`, plus `config.json` and `worker.config.json` | Different: Alchemy writes `dist/client` and `dist/ssr` (`dist/` alone for an assets-only project) and no Build Output metadata, which only `cf deploy` reads. The files inside each directory match | `build.test.ts` |

### Dev server

| Behavior | Status | Test |
| --- | --- | --- |
| Module runner in workerd: HMR, source-mapped stacks, sealed exports, `cloudflare:workers` `env` without internal bindings | Matched | `ViteRuntime.test.ts` (importable env, error page) |
| `__VITE_ENVIRONMENT_RUNNER_IMPORT__` for child environments (`import.meta.viteRsc.loadModule`) | Matched | `ViteRuntime.test.ts` (child environment), React Router RSC |
| Export wrappers for `WorkerEntrypoint`, `DurableObject`, `WorkflowEntrypoint` and their handler keys | Matched | `constants.test.ts`, `ViteRuntime.test.ts` (entrypoints, Durable Objects, Workflows) |
| Restart when the entry's export types change | Matched | `dev-export-types.test.ts` |
| Restart when an additional module file changes | Matched | `dev-assets.test.ts` |
| Uncaught `fetch` errors on Vite's error page | Matched | `ViteRuntime.test.ts` (error page) |
| An unresolvable `main` fails the dev start | Matched | `ViteRuntime.test.ts` (config changes) |
| `run_worker_first` routing ahead of Vite's middlewares; the router and asset worker | Matched | `ViteAssetRouting.test.ts` |
| HTML through `transformIndexHtml`, `public/` HTML raw, `server.headers` on assets | Matched | `dev-assets.test.ts` |
| Vite's bundled dev mode (`experimental.bundledDev`) | Matched | `ViteRuntime.test.ts` (bundled dev) |
| The Worker's `ASSETS` binding runs through Vite's middlewares | Matched | `dev-assets.test.ts` |
| WebSockets to the Worker; Vite's HMR and DevTools (`/__devtools/__ws`) sockets left alone unless from a Sandbox preview origin, HMR upgrades closed when `server.ws` is `false`; a socket another `upgrade` listener answers is left to it | Matched | `websockets.test.ts`, `constants.test.ts`, `ViteRuntime.test.ts` (WebSockets) |
| A refused WebSocket upgrade | Different: the Worker's response reaches the client (upstream resets the socket) | `websockets.test.ts` |
| `/cdn-cgi/local/*` trigger endpoints | Matched | `ViteRuntime.test.ts` (scheduled and email) |
| The legacy `/cdn-cgi/mf/*` and `/cdn-cgi/handler/*` trigger paths | Different: still served. v2 stopped rewriting them, but Alchemy's runtime answers both, so scripts written against v1 or Wrangler keep working, and dropping them gains nothing | `ViteRuntime.test.ts` (scheduled and email), `Email.test.ts` |
| Public URL from the dev server's host, port and HTTPS | Matched | `ViteStreaming.test.ts` (HTTPS) |
| `X-Forwarded-Host`, `X-Forwarded-Proto` (case-insensitive), `ctx.access` from `dev.access` | Matched | `forwarded-host.test.ts`, `ViteRuntime.test.ts` (headers, Access) |
| The Worker's response status text (dev and preview) | Matched | `dev-proxy.test.ts` |
| Repeated `Set-Cookie` request headers reach the Worker as separate values | Matched | `dev-proxy.test.ts` |
| A request or upgrade target starting with `//` (or `/\`) stays a path on the dev server's origin | Matched | `dev-proxy.test.ts`, `websockets.test.ts` |
| Outbound `fetch`: no `CF-Connecting-IP`, `cf.image` | Matched | `Runtime.test.ts` (outbound), `ViteRuntime.test.ts` (cf.image) |
| Outbound `fetch`: `CF-Worker` | Different: not added; Cloudflare-fronted sites answer 403 to one sent from a developer machine (#2965) | `ViteRuntime.test.ts` (CF-Worker), `Runtime.test.ts` (outbound) |
| Restart after a workerd crash | Matched | `ViteRuntime.test.ts` (workerd crashes) |
| Containers built from a Dockerfile | Matched | `ViteRuntime.test.ts` (containers) |
| Alchemy's runtime variables (`ALCHEMY_*`) in `env` and `process.env` | Different: Alchemy's runtime reads them; documented on `env` | `ViteNodeCompat.test.ts` (process-populated-env) |
| `/__debug` inspector page, structured log levels | Out of scope (presentation) | — |

### Preview

| Behavior | Status | Test |
| --- | --- | --- |
| `vite preview` serves the built Worker and its assets | Matched | `preview-plugin.test.ts`, `ViteBuild.test.ts` (prerendering) |
