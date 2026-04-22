# cloudflare-worker-paired-do

**Minimal repro for [issue #72](https://github.com/alchemy-run/alchemy-effect/issues/72) — Container app deploys without DO namespace linkage due to circular `Output<T>` dependency in `bindContainer`.**

This example demonstrates the **paired-DO pattern** that real-world projects adopt when they need to:

1. Put container runtime code in a **separate file** from the `Container` resource declaration (so the DO-side bundle doesn't pull in heavy runtime deps like `sharp`, `impit`, `playwright`).
2. Declare the `DurableObjectNamespace` as a **separate, explicit alchemy resource** (so a different Worker / different resource graph can bind to it without re-declaring the Container).

## Contrast with canonical `examples/cloudflare-worker` (Sandbox/Agent)

The canonical example inlines container runtime + DO binding:

```ts
// Sandbox.ts — Container class AND runtime in same file
class Sandbox extends Cloudflare.Container<Sandbox, {...}>()("Sandbox", {
  main: import.meta.filename,   // self-reference
  ...
}) {}
export default Sandbox.make(Effect.gen(function* () { return Sandbox.of({ ... }) }))

// Agent.ts — DO binds Container directly in its body
class Agent extends Cloudflare.DurableObjectNamespace<Agent>()("Agents",
  Effect.gen(function* () {
    const sandbox = yield* Cloudflare.Container.bind(Sandbox)
    return Effect.gen(function* () { /* handler */ })
  }),
) {}
```

This example splits them:

```ts
// src/MyContainer.ts — Container class only, NO .make() here
class MyContainer extends Cloudflare.Container<MyContainer>()("MyContainerApp", {
  main: "./src/container-runtime/server.ts",   // separate file
  ...
}) {}

// src/container-runtime/server.ts — runtime in dedicated file
export default MyContainer.make(Effect.gen(function* () { ... }))

// src/MyContainerDO.ts — paired DO resource with DIFFERENT LogicalId
class MyContainerDO extends Cloudflare.DurableObjectNamespace<MyContainerDO>()("MyContainer",
  Effect.gen(function* () {
    const container = yield* Cloudflare.Container.bind(MyContainer)
    /* handler */
  }),
) {}
```

## Why the LogicalIds differ

`Container` and `DurableObjectNamespace` both call `worker.bind` internally during construction. `Diff.ts` deduplicates `ResourceBinding[]` by `sid` with **last-write-wins** semantics. If both use LogicalId `"MyContainer"`, the DO namespace binding gets silently clobbered by the Container's binding, and runtime errors with `DurableObjectNamespace 'MyContainer' not found`.

The workaround: suffix the Container LogicalId with `App` (or any unique tag). The `className:` (= actual CF-side DO class name) remains `MyContainer` (comes from the class declaration), so runtime binding still resolves correctly — it's only the alchemy-internal `sid` that differs.

## The bug (issue #72)

When you deploy this example:

- Deploy reports success for both `MyContainerApp` (Container) and `MyContainer` (DO namespace).
- State file `.alchemy/state/<app>/<stage>/MyContainerApp.json` contains `durableObjects: null` (or `{}`) — the FK from the Container app to the DO namespace is silently missing.
- At runtime, calling the DO method that triggers `container.start()` errors with: `Error: no container application assigned to this Durable Object namespace`.

Root cause: circular `Output<T>` dependency between `Container.bind` (needs the DO's namespaceId) and the DO's own namespace (doesn't resolve until after the Container app references it).

## Reproduce

```bash
bun install
bun run deploy
curl https://<worker>.workers.dev/hello   # triggers DO.fetch() → container.start() → ERROR
```

Inspect the state to confirm the missing linkage:

```bash
cat .alchemy/state/CloudflareWorkerPairedDOExample/<stage>/MyContainerApp.json | jq '.durableObjects'
# Expected (for correct linkage): { "namespace_id": "...", ... }
# Actual (with bug):               null
```

## Related

- [Issue #72](https://github.com/alchemy-run/alchemy-effect/issues/72) — root bug report
- [PR #73](https://github.com/alchemy-run/alchemy-effect/pull/73) — minimum-viable fix: convert silent failure → loud diagnostic via `Effect.die` when resolved `namespaceId` is missing/empty. Does NOT fix the underlying circular dependency; just surfaces it at deploy time.
