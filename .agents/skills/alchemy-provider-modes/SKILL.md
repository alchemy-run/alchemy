---
name: alchemy-provider-modes
description: Implement Alchemy provider modes and local providers.
---

# Alchemy Provider Modes

## When to use

Load when changing live/local provider selection, `Alchemy.remote()`, `LocalProvider.make`, or local-provider tests.

# Provider Modes & Local Providers (doctrine)

Some resource types have TWO implementations: a **live** provider (converges real cloud state, `alchemy deploy`) and a **local** provider (emulates the resource on the developer's machine, `alchemy dev`). Provider mode is a first-class engine concept — see [ProviderMode.ts](../../../packages/alchemy/src/ProviderMode.ts), [Local/ProviderLayer.ts](../../../packages/alchemy/src/Local/ProviderLayer.ts), [Local/LocalProvider.ts](../../../packages/alchemy/src/Local/LocalProvider.ts), and the user-facing guide at [website/src/content/docs/infrastructure-as-code/local-provider.mdx](../../../website/src/content/docs/infrastructure-as-code/local-provider.mdx).

Engine semantics (never re-implement these per provider):

- **Register both variants with `ProviderLayer.dual(cls, { live: () => ..., local: () => ... })`** — never select one at layer build. The run-default variant builds eagerly; the other is lazy and memoized, so mode-specific dependency layers (workerd, Docker) MUST compose *inside* the `local` thunk (e.g. `LocalWorkerProvider().pipe(Layer.provide(localRuntimeServices()))`), never globally — a plain deploy must not construct local machinery unless a local-mode row needs deleting. Dep layers shared across several local providers must be **module-memoized layer references** so the build MemoMap dedupes them to one instance.
- **Every state commit stamps `providerMode`.** A persisted mode that differs from the resolved mode plans a REPLACEMENT (the provider diff is not consulted), and every delete — replacement old generations, GC chain draining, orphans, `destroy`, `sync`/`tail`/`logs` — resolves the provider variant of the row's *stamped* mode via `findProviderByType(type, mode)`. Legacy rows without a stamp are assumed **live** (pre-mode engines and mode-agnostic providers only ever acted on the real cloud), so a dev run replaces them like any stamped live row — assuming the run's mode instead would silently adopt a deployed live resource as a local instance and leak it untracked. The exception is an unstamped row whose attrs carry the local identity marker (`dev:`-prefixed ids, see `stampedMode` in `ProviderMode.ts`): it was reconciled by a pre-stamping `alchemy dev` run and is treated as **local**, so a plain destroy/deploy never hands its `dev:` identity to the live cloud API.
- **`Alchemy.remote()`** opts a resource or scope OUT of local emulation during dev (captured at registration like `adopt()`; a no-op during deploy). There is deliberately no `local()` — dev mode IS the local default; tests simulate a dev run by overriding `AlchemyContext.dev` (`inDev` in [test.resources.ts](../../../packages/alchemy/test/test.resources.ts)) or `Test.make({ dev: true })`. Conflicting decorations on one FQN die with `ConflictingProviderModeError`. Single-implementation providers are **mode-agnostic**: they satisfy any requested mode, never stamp, never replace on a switch — dev runs over constructs mixing emulatable and live-only resources (R2) just work.

## `LocalProvider.make` — long-running local providers

A local provider whose physical resource is a **running process** (dev server, workerd instance) MUST be built with `LocalProvider.make(cls, serverEntryUrl, spec)` — do not hand-roll FiberMap/instance-registry/hash machinery in the provider:

- **`resolveConfig(ctx)`** — the restart surface. Plain, canonically-hashable data only (no closures or runtime objects: derive plain *descriptors* here and materialize `BindingHook`s etc. inside `start` — see the descriptor/hook split in [LocalWorkerProvider.ts](../../../packages/alchemy/src/Cloudflare/Workers/LocalWorkerProvider.ts)). Must be cheap and side-effect-free — it runs inside `diff` on every plan. Its canonical hash decides noop-vs-restart AND the same value is handed to `start`, so "what changed?" and "what starts?" can never drift. Deliberately EXCLUDE runtime wiring observed at start time (e.g. queue consumers read from `LocalRuntimeState`) — sibling reconciles drive those via restart hooks, not config.
- **`start(ctx)`** — boot ONE instance in the ambient `Scope` and return Attributes at *readiness*; the process keeps running until the runner closes the scope on restart/delete. For processes that can die on their own, fork `ctx.invalidate` after the exit so the next plan reports `update`.
- **`stop(ctx)`** — delete-only cleanup for state that intentionally survives restarts (URL proxies kept for address stability, restart hooks). NOT called on restarts.
- Generated for you: instance registry, per-id lock (restarts never interleave), config-hash noop/restart, instanceId-guarded delete (a create-first replacement's old-generation delete cannot kill its successor), `list`. The provider is wrapped in `RpcProvider`, so during `alchemy dev` the registry lives in the sidecar and survives user-code hot reloads.
- **Never use `Hash.structure` to compare configs** — it XOR-folds sibling fields, so a value mirrored into two subtrees (env ↔ bindings) cancels out. The helper's canonical hash (sorted-key JSON + sha256, Redacted/bytes/cycle-aware) is the law.

Registry-style local providers (the "instance" is an in-memory row, e.g. Cloudflare's local Queue mutating `LocalRuntimeState`) do NOT use `LocalProvider.make` — write a plain provider and register it via `dual`.

Reference implementations: [Command/Dev.ts](../../../packages/alchemy/src/Command/Dev.ts) (minimal: spawn + URL readiness), [Cloudflare Workers LocalWorkerProvider.ts](../../../packages/alchemy/src/Cloudflare/Workers/LocalWorkerProvider.ts) (full-size: bundler watch loop, cross-restart proxy in `stop`), [Cloudflare Queues Queue.ts](../../../packages/alchemy/src/Cloudflare/Queues/Queue.ts) (registry-style, no runner). Engine coverage lives in [test/provider-mode.test.ts](../../../packages/alchemy/test/provider-mode.test.ts) and the "provider modes" describes in [plan.test.ts](../../../packages/alchemy/test/plan.test.ts) / [apply.test.ts](../../../packages/alchemy/test/apply.test.ts).

## Local tests (`{Resource}.local.test.ts`)

Every resource with a local (dev) provider gets a **`{Resource}.local.test.ts`** co-located with its live test, using `Test.make({ providers, dev: true })`. Dev-mode tests run local providers behind a **file-scoped RPC sidecar by default** — the same `RpcProviderProxy` topology the real `alchemy dev` command uses, where `providerServicesEffect` layers (e.g. `localRuntimeServices()`) are EMPTY in the test process and RPC-backed providers run their lifecycle in the sidecar. This is what catches a plain local provider that needs those services in the main process (the class of bug behind #1007, which in-process tests masked). `Test.make({ ..., sidecar: false })` opts a file back into the in-process topology — reserve it for debugging provider code or pinning the in-process path a plain `alchemy deploy` takes when deleting `providerMode: "local"` rows.

The suite must cover, minimum:

1. **The local roundtrip** — deploy the resource + a worker binding it (file-based fixture `main`, never inline `script` — unsupported in dev) and drive the binding over HTTP against the local simulator. Assert the resource's identity carries the `dev:` marker (proof no cloud call ran; for the Worker itself the marker is a `http://localhost:<port>` `url`).
2. **The `Alchemy.remote()` opt-out** — the same shape with the resource piped through `Alchemy.remote()`: assert a real (non-`dev:`) identity, round-trip through the remote-proxied binding, verify out-of-band via distilled that the write landed in the real cloud resource, and after `stack.destroy()` verify the cloud resource is gone (pins the stamped-mode delete path).

Reference: [KV Namespace.local.test.ts](../../../packages/alchemy/test/Cloudflare/KV/Namespace.local.test.ts) (includes the mixed local + live stack), [R2 Bucket.local.test.ts](../../../packages/alchemy/test/Cloudflare/R2/Bucket.local.test.ts), [D1 Database.local.test.ts](../../../packages/alchemy/test/Cloudflare/D1/Database.local.test.ts) (includes local migrations and the #1007 regression), [Queues Queue.local.test.ts](../../../packages/alchemy/test/Cloudflare/Queues/Queue.local.test.ts) (produce→consume through RPC-backed providers). The harness contract itself is pinned by [TestSidecar.test.ts](../../../packages/alchemy/test/Local/TestSidecar.test.ts).
