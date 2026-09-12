import * as AI from "alchemy/AI";

/**
 * CLOUDFLARE EMULATION — building a Cloudflare resource's local physics
 * in `packages/cloudflare-runtime`, the in-tree workerd runtime
 * `alchemy dev` runs Workers and their bindings on, and the local
 * provider in alchemy that drives it. Unlike AWS (a separate emulator
 * repository, one endpoint, the same reconciler) Cloudflare's local
 * mode is a SECOND PROVIDER per resource, registered beside the live
 * one, over a runtime this repository owns. Activated when a change
 * adds or alters a Cloudflare resource or binding, touches
 * `packages/cloudflare-runtime`, or a `*.local.test.ts`.
 */
export class CloudflareEmulation extends AI.Skill<CloudflareEmulation>(
  import.meta,
)("CloudflareEmulation") {}

export const CloudflareEmulationGeneral = CloudflareEmulation.make`
  # Emulating Cloudflare in cloudflare-runtime

  \`packages/cloudflare-runtime\` (\`@alchemy.run/cloudflare-runtime\`) is
  the local Workers runtime, in this repository: \`/core\` boots workerd
  for a \`RuntimeWorker\` and hosts its bindings, \`/vite\` and
  \`/rolldown\` are the build integrations. It must not depend on
  \`alchemy\` (alchemy depends on it), and it carries third-party
  notices (\`NOTICE\`, \`THIRD_PARTY_LICENSES.md\`) that a change
  borrowing from upstream updates. \`alchemy dev\` runs every Cloudflare
  resource on it by default; \`Alchemy.remote()\` opts one out to the
  real cloud. A local identity carries the \`dev:\` marker (a Worker's is
  a \`http://localhost:<port>\` url) — proof no cloud call ran.

  ## A binding is a plugin

  Each binding lives under \`core/bindings/{binding}/\`: a
  \`Plugin.Service\` that registers the binding in the workerd config
  (\`BindingHook\` → \`Worker_Binding\`, emitting its backing service
  once, on first use), a \`*.worker.ts\` internal worker that runs
  INSIDE workerd and implements the binding's API over \`Storage\` (the
  persistent directory under \`.alchemy/local\`), and a
  \`*Options.shared.ts\` for the types both sides import. Copy an
  existing binding's shape (\`kv-namespace/\`, \`r2-bucket/\`, \`d1/\`,
  \`queue/\`) before inventing one. Service bindings between local
  workers and tail consumers resolve through the dev registry
  (\`core/registry/\`), so workers may live in different processes and
  restart at any time; \`core/remote-bindings/\` binds a local worker to
  a REAL cloud resource (the \`Alchemy.remote()\` path);
  \`core/platform-proxy/\` (\`open\`) gives Node-side code the same native
  binding surface a Worker sees. Runtime tests are vitest projects
  (\`pnpm test\` in the package; \`test:core\`, \`test:vite\`,
  \`test:rolldown\`), against real workerd.

  ## The local provider in alchemy

  A resource with local physics registers BOTH variants with
  \`ProviderLayer.dual(cls, { live: () => …, local: () => … })\` — never
  selects one at layer build — and composes the runtime INSIDE the
  \`local\` thunk via the module-memoized \`localRuntimeServices()\`
  (\`Cloudflare/LocalRuntime.ts\`), so a plain deploy never constructs
  workerd and every local provider in one stack build shares one
  runtime. Every state commit stamps \`providerMode\`; a stamped mode
  that differs from the resolved one plans a REPLACEMENT, and deletes
  resolve the variant of the row's stamped mode — a local row is never
  handed to the cloud API. Two shapes of local provider:

  - A RUNNING PROCESS (a Worker, a dev server) is built with
    \`LocalProvider.make(cls, serverEntryUrl, spec)\`: \`resolveConfig\`
    (plain, hashable data — the restart surface; runs inside \`diff\` on
    every plan), \`start\` (boot one instance in the ambient Scope,
    return attributes at readiness), \`stop\` (delete-only cleanup).
    Never compare configs with \`Hash.structure\` — the helper's
    canonical hash is the law. \`Workers/LocalWorkerProvider.ts\` is
    the full-size reference.
  - A REGISTRY ROW (a Queue, a Namespace — a \`dev:\` id in
    \`LocalRuntimeState\`) is a plain provider registered via \`dual\`.

  The Node-side path into a local binding — what the \`*Local\` capability
  layers use at deploy time — is a \`Local{Cap}Gateway.ts\` beside the
  capability, opening a scoped platform proxy and reusing the binding's
  own client builders; it is scaffolding, never exported from
  \`index.ts\`.

  ## The proof

  Every resource with a local provider ships \`{Resource}.local.test.ts\`
  beside its live test, on \`Test.make({ providers, dev: true })\`, which
  runs local providers behind the RPC sidecar by default — the topology
  \`alchemy dev\` uses, and what catches a provider that needs runtime
  services in the wrong process. It covers, at minimum: the local
  roundtrip (deploy the resource plus a file-based Worker fixture
  binding it, drive the binding over HTTP, assert the \`dev:\` marker)
  and the \`Alchemy.remote()\` opt-out (a real identity, the write
  verified in the real cloud through distilled, and gone after
  \`stack.destroy()\`). A Cloudflare resource without both is not done
  locally.`;
