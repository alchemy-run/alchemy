# Serve — explicit mounts, generated exports, one bundle

The design for how an effectful Website's runtime reaches production and dev
on every framework and cloud. Supersedes the auto-injection / stand-down
design (the `DESIGN §` references in older comments point to that retired
doc; this file is now the authority).

## Why the redesign

The previous design auto-injected a generated wrapper entry around the
framework's build, and **decided whether to inject by grepping the compiled
output** for a marker literal (`__ALCHEMY_SERVE_MOUNT_v1__`) or raw import
specifiers. That had structural problems:

1. **Intent inferred from bytes.** Presence of a string in a bundle says
   something about the module graph, nothing about what the user meant. One
   transitive import moving (2026-08-16: `bridgeOf` imported from
   `Serve.ts`) put the marker in every value-form client bundle and silently
   deployed workers without their queue exports.
2. **Inverted failure polarity.** A false positive didn't fail loudly — it
   silently shipped a broken deploy.
3. **Two-phase bundling.** Alchemy re-bundled the framework's compiled
   output, with a scan-then-generate step in between.
4. **A name zoo.** Five mount functions (`toHandle`, `toRouteHandler`,
   `toEventHandler`, `toFetchable`, `make`) for one concept, existing to
   plumb per-framework env/ctx hiding places.
5. **Config duplication.** `server.routes` mirrored routing decisions that
   belong in code.

## Principles

- **The user owns HTTP composition.** The mount is user source, in the
  framework's own idiom. Alchemy is a handler the user calls — never the
  thing calling the user.
- **The program is the source of truth for platform wiring.** DOs,
  Workflows, queue consumers, and crons are registered by `yield*` in the
  backend program. Everything derived from them — class exports, bindings,
  migrations, consumers — is generated from plan-time knowledge. Nothing is
  ever decided by inspecting build output.
- **Never re-bundle the framework's artifact.** Tier A rides the
  framework's own bundle via a virtual entry; tier B carries the artifact
  byte-verbatim in a multi-module upload; AWS resolves through
  `node_modules`.
- **Failure polarity: loud.** A missing DO class export is a deploy error
  (Cloudflare rejects the binding), not a silent degrade.

## User surface

The entire user-facing API:

```ts
import { mount } from "alchemy/Serve";

const site = mount(Site);
site.fetch(request, env?, ctx?)   // Promise<Response | undefined>; undefined = "not mine"
```

- `env` omitted → resolved from the recipe's ladder (`process.env`, workerd
  importable env, framework globals).
- `ctx` omitted → the request scope settles **inline** before the response
  resolves (Lambda, dev servers, prerender — the correct semantics wherever
  no ExecutionContext exists). `ctx` present → finalizers ride
  `ctx.waitUntil` (workerd semantics). The settle strategy is chosen by
  what the caller passed — no ambient magic, no AsyncLocalStorage.

Advanced surface (cloud leaves, used by generated entries and
bring-your-own-build users only):

```ts
import { mount } from "alchemy/Cloudflare/Serve";   // + .platform, .exports
import { mount, toLambdaHandler } from "alchemy/AWS/Serve";
```

- `site.platform` — `{ queue?, scheduled? }` handlers in the cloud's native
  shapes, present only when the program registered them.
- `site.exports` — typed record of DO / Workflow classes (the only module
  surface that imports `cloudflare:workers`, hence a workerd-only leaf).
- `toLambdaHandler({ fetch, ...platform })` — the Lambda calling-convention
  adapter: one `streamifyResponse` wrap, event-shape branch (HTTP-shaped →
  `fetch`; SQS batch → `queue` with partial-batch responses; schedule →
  `scheduled`).

`mount` is memoized per site class (WeakMap): the user's mount, the
generated entry, and the value-form `createClient` share one runtime.

Deleted from the public surface: `server.routes` (routing is the mount's
code), the four framework adapter subpaths (`alchemy/Next`, `/Nitro`,
`/SvelteKit`, `/Astro` — each was ~10 lines of signature conversion, now
documented as one-liners in user code), `alchemy/Serve/Worker`,
`Serve.exports` (stub), and both marker literals.

## Tiers

**Tier A — the framework's worker entry passes through vite** and our
injected plugin can serve a *virtual* entry (Vite, TanStack Start, React
Router — the `@cloudflare/vite-plugin` model). One bundle, one alchemy
copy, dev runs the same graph in workerd.

**Tier B — the adapter emits the worker entry through its own internal
bundler** after vite finishes (SvelteKit's cloudflare adapter, Next via
OpenNext, Nuxt via nitro's preset, Astro). We cannot add exports to an
artifact we don't build, so a generated ~6-line glue module becomes the
uploaded script's `main_module`, importing the artifact byte-verbatim.

Tier membership is per-adapter and erodes toward A as Cloudflare migrates
frameworks onto the vite plugin. The **tier audit** (can kit run under the
CF vite plugin? does OpenNext expose a custom entry? is nitro's entry
overridable?) is the first open question of implementation.

## DX per framework

`src/backend.ts` and `alchemy.run.ts` are identical everywhere. The mount
file is the only variable, and it is identical across clouds (AWS simply
has no `ctx` to pass).

Owned entry (Vite / TanStack / React Router / Astro) — the user composes:

```ts
// src/server.ts  (RR: workers/app.ts; Astro: src/fetch.ts with astro(new FetchState(req)))
import framework from "@tanstack/react-start/server-entry";
import { mount } from "alchemy/Serve";
import Site from "./backend.ts";

const site = mount(Site);

export default {
  fetch: async (req: Request, env: Env, ctx: ExecutionContext) => {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");           // custom logic
    if (url.pathname.startsWith("/admin") && !(await verifySession(req)))
      return Response.redirect(new URL("/login", url), 302);
    return (await site.fetch(req, env, ctx)) ?? framework.fetch(req, env, ctx);
  },
};
```

Framework hook (SvelteKit / Next route file / Nuxt middleware) — the
framework's contract is the fallthrough:

```ts
// SvelteKit src/hooks.server.ts
export const handle = async ({ event, resolve }) =>
  (await site.fetch(event.request, event.platform?.env, event.platform?.ctx)) ??
  resolve(event);

// Next app/api/[[...slug]]/route.ts — the file's location IS the routing
const handler = async (req: Request) =>
  (await site.fetch(req)) ?? new Response("Not Found", { status: 404 });
export { handler as GET, handler as POST, /* … */ };

// Nuxt server/middleware/alchemy.ts
export default defineEventHandler(async (event) =>
  site.fetch(toWebRequest(event), event.context.cloudflare?.env, event.context.cloudflare?.ctx));
```

No user file, on any framework, ever contains: DO/Workflow/queue exports,
wrangler config, migrations, routes config, or binding env.

## Generated entries

Content is a pure function of `(site class, cloud, tier)`. Nothing exists
on disk — tier A is a plugin-served virtual module (absolute-path imports),
tier B is a string in the upload manifest, AWS is a member of the zip we
assemble. A `--emit` debug flag may dump read-only copies; dumps are never
build inputs.

Tier A (virtual module, set as the worker build's input):

```js
import entry from "<abs>/src/server.ts";
import Site from "<abs>/src/backend.ts";
import { mount } from "alchemy/Cloudflare/Serve";

const site = mount(Site);
export default { ...site.platform, ...entry };   // user's keys win
export const Counter = site.exports.Counter;
export const ReportWorkflow = site.exports.ReportWorkflow;
```

Tier B (AS IMPLEMENTED — better than the originally-designed glue+manifest
upload): alchemy's framework targets own their adapters' final bundle (the
in-memory kit adapter's worker shim, the OpenNext artifact takeover,
nitro's entry takeover, Astro's vendored-entry takeover), so the wrapper is
generated INSIDE our own pipeline and bundled in ONE rolldown graph with
the framework output and the backend — single alchemy copy, no split-brain
runtime, and the framework's artifact is never inspected to decide
anything. The wrapper is `makeWebsiteEntryExports`: the framework's fetch
(with the user's hook mount inside) grafted VERBATIM, plus the bridge's
non-fetch dispatch and the DO/Workflow class exports:

```js
// e.g. kit's WorkerShim effect arm (Next/Nuxt/Astro emit the same shape)
export default makeWebsiteEntryExports(WorkerEntrypoint, {
  site: Site,
  fetch: (request, env, ctx) => kit_handler.fetch(request, env, ctx),
});
const __do = DurableObjectBridge(DurableObject, { site: Site });
export class Counter extends __do("Counter") {}
const __wf = WorkflowBridge(WorkflowEntrypoint, { site: Site });
export class ReportWorkflow extends __wf("ReportWorkflow") {}
```

(The glue-string + verbatim multi-module-upload design remains the
fallback for a future adapter whose pipeline we genuinely cannot own —
none of the current six needs it.)

AWS (phase 4, planned; zip member shipping unbundled — `node_modules`
resolution gives the framework handler and this wrapper the same alchemy
instance):

```js
import { handler as framework } from "./framework/index.mjs"; // or entry.default.fetch (owned entry)
import Site from "./backend.mjs";                             // transpiled, alchemy external
import { mount, toLambdaHandler } from "alchemy/AWS/Serve";

const site = mount(Site);
export const handler = toLambdaHandler({ fetch: framework, ...site.platform });
```

Degenerate cases: no registrations ⇒ the wrapper carries only the grafted
fetch; AWS wrapper still owns the streamify wrap.

### Runtime copies

One copy of everything, both tiers — tier B's single rolldown graph
deduplicates the backend's alchemy imports with the wrapper's. (The only
double-copy that ever existed was inherent to `createClient` inside a
framework bundle that ALSO shipped a separate alchemy bundle; owning the
final bundle removed it.) AWS: one copy via `node_modules`.

## Dev

- **Tier A:** `alchemy dev` runs the framework's vite dev with the CF vite
  plugin — the same virtual entry, same graph, inside local workerd.
  Custom entry logic, DOs, Workflows, queue delivery, HMR: one process,
  dev ≡ prod.
- **Tier B (AS IMPLEMENTED for kit):** the framework's own dev server
  runs HTTP — the mount is app code, so hooks/route files run natively
  with full HMR; `site.fetch(request)` settles inline (no ctx in Node).
  The platform half is HOSTED IN THE DEV PLATFORM PROXY'S workerd
  (`hostedPlatform`): a rolldown-bundled platform entry (backend +
  DO/Workflow bridge classes + queue/scheduled delegation) becomes the
  proxy worker's modules, Workflow classes are re-exported as named
  entrypoints for the local engine, and Workflow `Instance` values cross
  the Node boundary as `{$: "workflow-instance", id}` facades whose
  methods chain through the binding's idempotent `get(id)`. The dev
  child's `process.env` carries the stack markers (the env ladder's
  fallback — what the value-form `createClient` resolves). Known
  limitation (tracked): Stream-returning DO RPC consumed from the Node
  side arrives empty (no nested-stream transport in the proxy).
- **AWS:** the framework dev server + the same sidecar model; the bridge
  runs in Node with ambient credentials (`Alchemy.remote()` resources hit
  real cloud, unchanged).

## Code layout

Shared (`packages/alchemy/src/Serve/`): `Bridge.ts` (core — memoized
builds, healing, request scope, settle-by-argument, world guard; the
delicate part, unchanged in spirit), `Serve.ts` (`mount` only), `Env.ts`,
`Routes.ts` (internal util). `constants.ts` keeps `SERVE_BRIDGE_KEY`
(how `createClient` finds the bridge); both markers die
(`SERVE_SENTINEL` pending the deploy-validation decision).

Cloud (`Cloudflare/Workers/ServeBridge.ts` → public `alchemy/Cloudflare/Serve`;
`AWS/Lambda/ServeBridge.ts` → public `alchemy/AWS/Serve`): recipes +
`.platform`/`.exports`/`toLambdaHandler`. New in `Cloudflare/Workers/Sources/`:
the `FrameworkArtifact` source (artifact walk → upload parts, glue
authoring, `platform.mjs` pass) and the virtual-entry vite plugin.
`AWS/Website/*`: zip assembly (`handler.mjs`, transpiled `backend.mjs`);
sibling-lambda event sources retired for the single-handler branch.

Framework-specific (`packages/frontend-frameworks/`): shrinks to **data +
build orchestration** — tier, artifact path, build/dev-server invocation,
tier A plugin injection. Zero framework-specific runtime code anywhere.
Deleted: `scanForExplicitServeMount`, `SERVE_MOUNT_PATTERN` (both copies),
`EffectDispatch.ts`, `DevServer.ts` front-dispatch, `WorkerShim.ts` effect
arm, wrapper snippets.

Engine: `Website` props lose `server.routes` (breaking); plan-time
registration exposed as a typed manifest to the entry generators; dev
gains the per-site sidecar platform worker (via `LocalWorkerProvider`).

## Test doctrine: MaxSite everywhere

One canonical fixture program used by **every** suite and example — no
framework gets a happy-path fixture:

- `fetch`: effect API + a streaming route (scope ejection) + a route with a
  request-scope finalizer (settle semantics);
- `Counter` DO (RPC incl. a Stream method, SQLite storage);
- `ReportWorkflow` (task w/ retries + sleep + `waitForEvent`);
- `Jobs` queue: producer from fetch AND consumer writing a KV marker;
- cron writing a KV marker; KV + D1 used by fetch, DO, and consumer;
- an RPC method for the value-form `createClient` path.

The mount fixture is always the **maximal entry** (healthz in-entry, auth
gate, then `site.fetch ?? framework`) — dispatch-order bugs live there.

Unit (fast): glue/virtual-entry generation from a maximal manifest (2 DOs,
1 workflow, queue, cron; user-key precedence: a user `queue` shadows
ours); vite-plugin build of MaxSite → artifact exports asserted; upload
assembly from a chunked+wasm+dynamic-import artifact fixture;
`toLambdaHandler` × 4 event fixtures (streamed HTTP unbuffered, SQS
partial-batch); settle-by-argument (ctx ⇒ waitUntil, none ⇒ inline —
pinned at unit level).

Examples (the acceptance gate) — every framework × cloud cell runs **both
legs** with the shared MaxSite:

1. **Dev leg** (`alchemy dev`, sidecar harness): drive a framework page,
   the effect API, and the custom entry routes; DO round-trip
   (monotonic increment ⇒ instance identity) + streaming RPC; queue
   produce → bounded `Effect.repeat` poll for the consumer's KV marker;
   workflow start → deliver `waitForEvent` → poll completion; assert
   local identity (`dev:` markers) with one `Alchemy.remote()` resource
   asserted real.
2. **Live leg** (real deploy, `beforeAll(deploy)`/`afterAll(destroy)`,
   `NO_DESTROY` valve): same drives against the deployed URL; out-of-band
   verification via distilled (DO namespace, workflow instance, consumer
   config); tier B's two-copy property (KV write crosses, module-global
   does NOT); destroy and verify gone.

Matrix: TanStack + Vite + React Router (tier A) and SvelteKit + Next +
Nuxt + Astro (tier B) on Cloudflare; TanStack + Next + SvelteKit on AWS
(single-lambda: HTTP and SQS on one function, streaming intact).
`monorepo-frontends` is the aggregate: three MaxSites, mixed tiers and
clouds, both legs.

**Cloudflare first.** All design details are proven on Cloudflare
(seconds-fast deploys) before any AWS testing begins (CloudFront ≈ 20+
min). AWS enters at phase 4, after the mechanics are settled.

## Phases

1. **Core**: `mount`, `site.fetch(request, env?, ctx?)`,
   settle-by-argument. Pure refactor over the existing bridge; all current
   tests stay green. Heals the `serve.make` structural break in
   `EffectDispatch` (latent since the toHandler rename).
2. **Tier A end-to-end** (TanStack on Cloudflare): virtual-entry plugin,
   single bundle, exports, workerd dev. MaxSite example, both legs.
3. **Tier B end-to-end** (SvelteKit on Cloudflare): glue + multi-module
   upload + sidecar dev. MaxSite example, both legs.
4. **AWS**: `toLambdaHandler`, retire sibling lambdas, zip assembly.
   MaxSite examples, both legs.
5. **The purge**: markers, scan, adapters, `EffectDispatch`,
   `server.routes`, dead subpaths — deleted only when every example is
   green on the new path (no commit has both mechanisms load-bearing).
6. Remaining frameworks + docs/tutorial rewrite.

## Open questions

- **Tier audit** (phase 2/3 entry): kit under the CF vite plugin; OpenNext
  custom-entry override; nitro entry override. Determines tier B's final
  membership — members may graduate to A with no user-visible change.
- **`SERVE_SENTINEL`**: retire outright, or keep as a cheap deploy-time
  sanity assert until deploy validation covers it.
- **Astro fetchable maturity**: `astro/fetch` is experimental; if it
  regresses, Astro falls back to a hook-style mount.
