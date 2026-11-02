---
name: dev-bridges
description: Make `alchemy dev` work when emulated and real-cloud resources meet — a local Lambda or Worker reaching an `Alchemy.remote()` resource, a real event source invoking local code, a resource in another cloud. Inventories a cloud's bindings, event sources and network connections, classifies each by how it talks, picks one bridging strategy per class, implements it once at the cloud's central seam, and gates the whole surface with an audit and one local test per class. Use for "make remote() work for X", "local Lambda can't reach a remote resource", "bridge local and remote", "dev mixing local and live", "SST-style live Lambda", "cross-cloud dev", or after adding a local provider to a cloud.
---

# Bridging local and remote in `alchemy dev`

`alchemy dev` emulates what it can and leaves the rest in the real cloud.
`Alchemy.remote()` moves a resource out of emulation on purpose. Wherever
an emulated thing and a real thing meet, something has to carry the traffic
across. This skill is the process for doing that for a cloud's *whole*
surface, not one binding at a time.

The bar: **every cell is bridged, emulated, or rejected by name.** No dev
interaction may silently land on the wrong side. That is the bug this
process exists to prevent. A local Lambda's SQS `SendMessage` to a remote
queue used to reach floci and fail with `QueueDoesNotExist`; a local
Lambda's queue event source still maps the real queue's ARN inside floci and
never fires.

Read first: [AGENTS.md](../../../AGENTS.md) **Provider Modes & Local
Providers**, [ProviderMode.ts](../../../packages/alchemy/src/ProviderMode.ts),
[Binding.ts](../../../packages/alchemy/src/Binding.ts) (`Targets`,
`routeClientDataPlane`), and the cloud's local-development page under
`website/src/content/docs/{cloud}/local-development.mdx`.

## The model

Every dev interaction is an **edge** between a *caller* and a *callee*.
Three kinds of edge exist:

- **Call** — runtime code calls a resource's API through a binding
  (`SQS.SendMessage(queue)`, `R2.ReadBucket(bucket)`).
- **Event** — a resource invokes runtime code through an event source
  (`QueueEventSource`, S3 notifications, API Gateway, a Queue consumer).
- **Connect** — runtime code opens a socket to a resource's network
  endpoint (`RDS.Connect`, `ElastiCache.Connect`, Hyperdrive).

Each end sits in one **placement**: *local* (emulated, `dev:` identity),
*remote* (real cloud, same provider), or *foreign* (real cloud, another
provider). A **cell** is `(edge kind, caller placement, callee placement)`.
Local→local is the emulator's job and already works; every other cell
needs a strategy or a rejection.

## The strategies

Use the first one that fits the cell. Each is implemented once per cloud.

1. **Direct.** The local caller calls the real public API with the
   developer's own credentials, relayed into the emulator by the dev
   sidecar. Fits call edges whose API is reachable over the internet and
   signable from anywhere. Reference: AWS `AWSBindings.withCredentials`
   decides per call (`Binding.Targets` + per-resource markers), with the
   relay in `Local/DevWatchProvider.ts` (#2684).
2. **Pull.** The sidecar consumes the real source (queue lease, stream
   shard iterator, change feed) and delivers each batch to the local
   runtime's handler, acking only after the handler succeeds. Fits event
   edges whose source can be polled, on a host type with no stub host.
   Reference: Cloudflare Queues `http_pull` consumer + pull loop
   (`Queues/Consumer.ts`). Where a stub host exists, prefer it for pull
   sources too: the cloud's own poller (a Lambda event-source mapping)
   then keeps batching, partial failures and retries exactly as deployed,
   with no per-source poller to write.
3. **Stub host.** The SST "Live Lambda" pattern. Deploy the *host* for
   real, with a stub body; real triggers invoke the stub, which forwards
   each invocation to the sidecar over a channel the sidecar dials out to,
   waits for the local result and returns it. One stub per host type
   covers every push source on that host at once, because the platform
   sees a real function with a real role. Fits event edges that push:
   S3/EventBridge/SNS → Lambda, API Gateway, Cognito triggers, Step
   Functions tasks. Prefer a cloud-native channel the developer's
   credentials already reach (an SQS request/reply pair, IoT Core or
   AppSync Events websockets on AWS; a Durable Object websocket on
   Cloudflare) over a public ingress. Reference: AWS
   `Lambda/DevBridge.ts` (`wireEventSource`), `Lambda/dev-stub`, and
   `Local/DevBridgeRelay.ts` (requests on SQS, responses in S3).
4. **Remote proxy.** Deploy a small real proxy that holds the native
   binding, and forward the local client's calls to it over authenticated
   HTTP. Fits call edges that only exist as native bindings.
   References: Cloudflare remote bindings
   (`cloudflare-runtime/src/core/remote-bindings`) and `Queues/QueueShim.ts`.
5. **Tunnel.** Open a port forward into the private network (SSM Session
   Manager or an EC2 Instance Connect Endpoint on AWS, a Cloudflare Tunnel)
   and rewrite the connect edge's host and port to the local end. Fits
   connect edges to VPC-only endpoints.
6. **Ingress.** Expose a local URL publicly through the dev relay or a
   tunnel. Fits event edges that push to an arbitrary URL: webhooks, SNS
   HTTPS subscriptions, EventBridge API destinations.
7. **Reject.** Fail at plan time with `UnbridgedDevEdge`
   (`alchemy/ProviderMode`), naming both ends, the edge kind and the
   workaround (`Alchemy.remote()` both ends, or neither). The engine
   already rejects every real-cloud resource whose inputs come from an
   emulated one (`Plan.ts`), which covers remote→local calls and
   references for every cloud; a cloud adds by-name rejects at its seams
   for the cells the plan can't see (a local host dialing a private
   endpoint, a cross-side target builder).

Foreign edges reuse the same strategies with the provider pair's credential
federation: an IAM user + access key for non-AWS hosts, Google
service-account web identity to an AWS role, a scoped Cloudflare API token.
Local→local across clouds needs only endpoint routing (a local Worker
reaching floci's gateway).

Bridge resources (stubs, proxies, pull consumers, tokens) are ordinary
engine-managed resources, declared only in a dev run when a cell needs
them. The engine then orders, updates and deletes them, and `alchemy
deploy` garbage-collects them. Long-lived work (pollers, relay
connections, credential refresh) runs in the existing dev sidecar fiber
tree, never in a new process.

## The process, per cloud

### 1. Inventory the surface

List every binding, event source and connect binding the cloud package
exports, with a script, not by reading. Classify each member by
**transport class**:

| Class | Example | Default strategy |
| --- | --- | --- |
| public API call | SQS `SendMessage`, S3 `GetObject` | Direct |
| native-only call | Cloudflare KV, R2, Queue producer | Remote proxy |
| private connect | RDS, ElastiCache, MemoryDB | Tunnel |
| pull event | SQS/Kinesis/DynamoDB Streams → Lambda, CF Queue consumer | Pull |
| push-to-function event | S3/EventBridge/SNS → Lambda, API Gateway | Stub host |
| push-to-URL event | SNS HTTPS, webhooks | Ingress |

Write the inventory to `.agents/skills/dev-bridges/{cloud}.md`: one row per
class with its members, chosen strategy, central seam and status.

### 2. Reproduce each class

For each class, add the remote case to a `{Resource}.local.test.ts` (see
**Local tests** in AGENTS.md): a local host plus one representative member
piped through `Alchemy.remote()`, driven over HTTP, verified out of band in
the real cloud, and gone after `stack.destroy()`. Run it and watch it fail
before fixing anything. One representative per *class* is enough, but pick
it from the class's most common construction shape (see step 3).

### 3. Find the seam and route everything through it

Each class has one function every member should pass through (AWS calls:
`AWSBindings.Bind` + `withCredentials`; Cloudflare calls: the
`RuntimeBindings.ts` switch; event sources: the host's event-source binding
contract). Audit for members that bypass it or use it in a shape the
strategy can't see, and fix them first, with a scripted codemod rather
than by hand. Decide **per call, not per construction**: most bindings
resolve their operations when the layer is built, before any resource is
bound, so a decision made at construction misses them. That is exactly how
the first AWS fix covered S3 and missed ~265 other bindings.

Keep the same-side path byte-for-byte what it was: a seam that changes a
deployed resource's namespace or logical id replaces it on every existing
stack. Push extra namespacing only on the bridged path (AWS's stub
triggers live under the host). Wiring declared outside a host's init
(Pipes, `events(bus).toLambda(fn)`) has no runtime context, so the seam
attaches what the sidecar needs to the host as a binding, not runtime env.

### 4. Implement the strategy once, at the seam

Write it centrally. Per-service differences are declared hooks on the
seam (ack semantics, payload encodings like the Queue shim's `v8`
rejection, region pinning), never a second implementation in the service.

### 5. Reject the rest by name

Every cell without a strategy fails at plan time with the typed error from
strategy 7. A silent fallback to the emulator is a bug, even when nothing
reaches it yet.

### 6. Gate

- An audit script in CI that fails when a member of a bridged class doesn't
  use its seam. Reference: `scripts/check-dev-bridges.ts`
  (`pnpm dev-bridges:check`).
- The per-class local tests from step 2, green.
- The cloud's `local-development.mdx` gains the matrix: which cells work,
  how, and which are rejected.

## Current state

| Cloud | Call | Event | Connect |
| --- | --- | --- | --- |
| AWS | Direct for every binding; local Workers calling AWS rejected | Stub host for every Lambda event source and target builder; other targets rejected | private endpoints rejected; public-capable ones reached directly |
| Cloudflare | Remote proxy (remote bindings), Queue shim | Pull for Queue consumers | n/a |
| GCP | no local providers yet | — | — |

Per-cloud inventories: [aws.md](aws.md).

## Footguns

- **Construction-time decisions.** Anything that reads `Binding.Targets`,
  env or mode while the layer is built sees no resource. Decide inside the
  call; `Binding.Targets` is provided around every runtime call of a
  bound client.
- **Ambient context wins at call time.** Distilled operations prefer the
  caller's context over the one they were yielded in, and an emulated
  host's ambient names the emulator. Provide the bridge's context around
  each call, not just at resolution.
- **Permission parity.** Direct runs with the developer's permissions, not
  the host's role. A missing IAM grant only shows up after deploy. Say so
  in the docs, and prefer Stub host where the role itself matters.
- **Fresh hostnames.** A stub or proxy URL queried before public DNS has
  it gets negatively cached for minutes. Wait on the authoritative
  nameservers before the first request.
- **Payload fidelity.** A bridge re-encodes messages. Check what can't
  cross (V8-serialized values, binary attributes, ordering, FIFO dedupe)
  and reject it with a clear error.
- **Leaks.** Bridge resources must disappear on `stack.destroy()` and on
  promotion to `alchemy deploy`. Every bridge test verifies that out of
  band.
