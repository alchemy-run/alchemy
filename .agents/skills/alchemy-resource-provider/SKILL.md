---
name: alchemy-resource-provider
description: Author Alchemy resources, capabilities, and providers.
---

# Alchemy Resource Provider

## When to use

Load before implementing or changing a resource provider, capability, binding, event source, or lifecycle test.

# Workflow (per-service inner loop)

This is the inner loop that each factory agent (see [Alchemy resource factory](../alchemy-resource-factory/SKILL.md)) executes for the service it owns — it applies equally when a single engineer brings up one service by hand.

Development of Alchemy-Effect Resources is heavily pattern based. Each Service has many Resources that each have 0 or more Capabilities and Event Sources. When working on a new Service, the following steps should be followed.

1. Research the AWS Service and identify its Resources, Identifier Types, Structs, Capabilities, and Event Sources. Refer to the corresponding Terraform Provider, Pulumi Provider, and CloudFormation docs for that service (use the provided tools specifically for searching these docs for services and resources).

Example (abbreviated):

Service: S3

Resources:

- Bucket
- BucketPolicy
- etc.

Bucket Capabilities:

- GetObject
- PutObject
- DeleteObject

Identifier Types:

- Bucket Name
- Bucket ARN

Structs:

- CorsRule
- LifecycleConfiguration

2. Document each of the Resource interfaces

Include the following information:

- ResourceName, e.g. Bucket, Instance, Queue
- Input Properties (for each property: Name, Type, Description, Default Value, Required, Constraints, Replaces: true/false)
- Output Attributes (for each attribute: Name, Type, Description)

3. Document each of the Capabilities and Bindings

Include the following information:

- Capability Name, e.g. `GetObject`, `PutObject` (it maps 1:1 with an AWS API)
- Constraints (e.g. `Key`)
- IAM Policies (how the capability maps to an IAM Policy, e.g. Effect: Allow, Action: s3:GetObject, Resource: `arn:aws:s3:::${bucketName}/${Key}`)
- Environment Variables (what environment variables should be added to a Lambda Function so that it can access the capability, e.g. `BUCKET_NAME`, `BUCKET_ARN`, `QUEUE_URL`, `QUEUE_ARN`, etc.)

4. Research and design each of the Lifecycle Operations

- **Diff** - identify which properties are always stable across any update, which properties change conditionally depending on new and old values, which properties trigger a replacement. This is usually just a distinct list, but can sometimes require if-this-then-that logic. Document it explicitly and exhaustively. Cross-reference with AWS CloudFormation, Terraform Provider and Pulumi Provider docs.

:::warning
You should almost never use `no-op` in the Diff. No-op should be explicitly designed as a way to say "i know this property changed, but i don't want it to trigger an update". This is an edge-case and not the norm. Usually you want diff to return `undefined` or `void` to let the engine apply the default update logic. Diff is usually just use as an optimization or to identify replacement instead of update.
:::

- **Read** - determine which API calls are required to read the Output Attributes of a Resource from the Cloud Provider state (otherwise known as refresh or synchronize resource state). This is usually a single Get{Resource} API call, but can be a complex set of calls depending on the Service. Read can also be called without the current Output Attributes because of past state persistence failures. These cases are handled by computing the deterministic Physical Name and looking it up or by searching for Resources using tags (if the Cloud Provider supports it). Read may return `Unowned(attrs)` when the resource exists but lacks our ownership tags, signalling the engine to gate adoption behind `--adopt` or `adopt(true)`.
- **Pre-Create** - determine if the Resource needs a pre-create operation. This is usually only the case for the special Function/Runtime Resources like AWS Lambda Functions. If it is required, then document which API call(s) should be called and what the empty (unit) input properties are. E.g. a Lambda Function takes a simple script that exports a no-op handler function.
- **Reconcile** - determine the API calls needed to converge the cloud's actual state to the desired state described by the new Input Properties. Reconcile must be a single flow that works whether the resource is missing (greenfield create), pre-existing under our ownership (update), or freshly adopted (`output` defined but `olds` absent). See the **Reconciler doctrine** section below.
- **Delete** - determine which APIs should be called and in what order to delete an existing Resource. Delete should be idempotent so that if the resource has already been deleted, it is not considered an error. It is common for deletions to fail because of Dependency Violations or Eventual Consistency Errors. These are not always called Dependency Violations in the API docs, so attention should be paid to investigating each API's possible error codes and how they should be handled by the Delete operation. Should we retry for a period of time, indefinitely, or fail immediately?

# Reconciler doctrine

The provider's `reconcile` function replaces the legacy `create` + `update` pair. It runs every time the engine wants to make the cloud match the desired state — whether that's the first time the resource is being provisioned, a routine update, or a takeover after `read` returned an existing cloud resource.

It receives `output: Attributes | undefined` and `olds: Props | undefined`:

| `output`     | `olds`       | Meaning                                           |
| ------------ | ------------ | ------------------------------------------------- |
| `undefined`  | `undefined`  | Greenfield — no prior physical resource           |
| defined      | defined      | Routine update — engine-owned resource            |
| defined      | `undefined`  | Adoption — engine adopted via `read`              |

A reconciler MUST work correctly for all three combinations. It MUST NOT branch the body on `output === undefined` and run different code paths for "create" vs "update". That pattern is just rename-and-branch and re-introduces every assumption the old `create`/`update` split made. Instead, write one flow:

```
1. Observe   — derive the physical identifier; read live cloud state via getX/describeX
2. Ensure    — if the resource is missing, call createX. Catch AlreadyExists/ConflictException
                as a race and continue. Wait for active state if applicable.
3. Sync      — for each mutable aspect (settings, sub-resources, tags, policy):
                 - read OBSERVED cloud state (not olds)
                 - compute desired state from news + bindings
                 - diff observed against desired
                 - apply only the delta API call (skip the API entirely on no-op)
4. Return    — re-read final state if needed; return the fresh Attributes shape
```

Key invariants:

- **Observation > assumption.** Cloud state is authoritative. `olds` is at most a hint to skip a no-op API call; it is never the source of truth for what's actually deployed.
- **Each sync step is independently idempotent.** Crash mid-reconcile, re-run, you converge.
- **`output` is treated as a cache** for stable identifiers (physical name, ARN, immutable id). It is NOT a guarantee that the resource still exists. If it doesn't, observation falls through to "missing" and ensure recreates.
- **`AlreadyExists`/`NotFoundException`/`ResourceInUseException`-style errors are caught**, not propagated — they're races or eventual-consistency, not failures.
- **Tags use observed cloud tags as the diff baseline**, not `olds.tags` or `output.tags`. Adoption may bring you a resource with foreign tags that need to be reconciled.

:::warning
**Do not write `if (output === undefined) { /* create body */ } else { /* update body */ }`.** That is rename-and-branch, not reconciliation. The reconciler's body is one observe-ensure-sync flow that produces correct cloud state regardless of starting point.
:::

The canonical reference reconcilers cover the common shapes:

- [S3 Bucket](../../../packages/alchemy/src/AWS/S3/Bucket.ts) — uses `ensureBucketExists` + `syncBucketTags` + `syncBucketPolicy` helpers; each helper is itself a tiny reconciler.
- [SQS Queue](../../../packages/alchemy/src/AWS/SQS/Queue.ts) — observe via `getQueueUrl`, ensure via `createQueue` (tolerates `QueueNameExists` race), sync attributes by diffing `getQueueAttributes` against desired, sync tags.
- [Kinesis Stream](../../../packages/alchemy/src/AWS/Kinesis/Stream.ts) — many mutable aspects (mode, shards, retention, encryption, metrics), each its own observed-vs-desired sync block.
- [DynamoDB Table](../../../packages/alchemy/src/AWS/DynamoDB/Table.ts) — multi-API observation (table + tags + PITR + TTL), per-aspect diffing, GSI delta application.
- [EC2 Vpc](../../../packages/alchemy/src/AWS/EC2/Vpc.ts) — auto-assigned id, observe via `describeVpcs([output.vpcId])` with NotFound fallback to create, sync DNS attrs by reading `describeVpcAttribute`, sync tags from observed `vpc.Tags`.
- [Lambda Function](../../../packages/alchemy/src/AWS/Lambda/Function.ts) — uses `createOrUpdateFunction` / `createOrUpdateFunctionUrl` / `attachBindings` helpers, each idempotent.
- [Cloudflare Worker](../../../packages/alchemy/src/Cloudflare/Workers/Worker.ts) — non-AWS API; the underlying `putWorker` is a true upsert, so reconcile observes existing settings and delegates.

Existence-only resources (Lambda Permission, EC2 Route, EC2 RouteTableAssociation, IAM AccessKey, etc.) have nothing mutable beyond their identity. Their reconciler is just observe → if missing, create. There is no sync step.

5. Research and design the test cases for each resource. Test cases can be single or multi-step. Single-step test cases are just testing a single create success or failure mode. Multi-step cases are testing a sequence of operations, starting with create and then updating or replacing the resource multiple times. Test cases should be designed to be exhaustive and cover all possible success and failure modes, starting from simple happy paths to long, complicated aggregate (including other resources) smoke tests.
6. Implement the Resource contract and Provider in `packages/alchemy/src/{Cloud}/{Service}/{Resource}.ts`.

The Resource contract (Props, Attributes, Binding Contract) and the Resource Provider (lifecycle operations) are co-located in the same file.

Read through the established examples to understand the pattern:

- [S3 Bucket](../../../packages/alchemy/src/AWS/S3/Bucket.ts)
- [SQS Queue](../../../packages/alchemy/src/AWS/SQS/Queue.ts)
- [DynamoDB Table](../../../packages/alchemy/src/AWS/DynamoDB/Table.ts)
- [Kinesis Stream](../../../packages/alchemy/src/AWS/Kinesis/Stream.ts)
- [Lambda Function](../../../packages/alchemy/src/AWS/Lambda/Function.ts)
- [VPC](../../../packages/alchemy/src/AWS/EC2/Vpc.ts)
- [Subnet](../../../packages/alchemy/src/AWS/EC2/Subnet.ts)

The Resource interface takes four type parameters: `Resource<Type, Props, Attributes, BindingContract>`.

```ts
export interface Stream extends Resource<
  "AWS.Kinesis.Stream",
  StreamProps,
  {
    streamName: string;
    streamArn: string;
    streamStatus: StreamStatus;
  }
> {}

export const Stream = Resource<Stream>("AWS.Kinesis.Stream");
```

For Resources that accept Bindings (like Lambda Function), include a fourth type parameter for the Binding Contract:

```ts
export interface Function extends Resource<
  "AWS.Lambda.Function",
  FunctionProps,
  {
    functionArn: string;
    functionName: string;
    functionUrl: string | undefined;
    roleName: string;
    roleArn: string;
  },
  {
    env?: Record<string, any>;
    policyStatements?: PolicyStatement[];
  }
> {}
```

:::warning
**Never use `Input<T>` in declared Props interfaces.** Declare plain types (`zoneId: string`, `ips?: string[]`, nested structs with plain fields). The `Resource` machinery applies `Input` automatically — and `Input<T>` is deep (it recursively distributes over arrays and object fields), so even nested references like `memberships: [{ identifier: zone.zoneId }]` accept `Output<string>` without any explicit annotation. Writing `Input<string>` in a Props interface produces a redundant double-wrap.

```ts
// ❌ wrong
export interface LoadBalancerProps {
  zoneId: Input<string>;
}

// ✅ right — the engine wraps automatically and deeply
export interface LoadBalancerProps {
  zoneId: string;
}
```

`Input<T>` in a *function signature* is still legitimate when the function genuinely receives unresolved values at runtime (e.g. helpers that resolve tag maps, or `DurableObjectNamespace.from(scriptName: Input<string>)`).
:::

7. Implement each Capability as a `Binding.Service` in `packages/alchemy/src/{Cloud}/{Service}/{Capability}.ts`.

A single `Binding.Service` does both halves of a capability in one Effect:

- **Init (outer) Effect** — resolves the host Function/Worker and its environment, then registers the deploy-time binding by calling ``host.bind`${resource}`(data)`` (environment variables + IAM policy statements for AWS, native bindings for Cloudflare), guarded by `!globalThis.__ALCHEMY_RUNTIME__` so it becomes a no-op once running inside the deployed Function/Worker.
- **Runtime (inner) callable** — the typed client returned to the caller; its methods require `Alchemy.RuntimeContext` (see below).

There is no separate deploy-time policy object and nothing to register in `providers()` — the implementation layer is provided directly on the Function/Worker Effect.

Read through the established capabilities to understand the pattern:

- [S3 GetObject](../../../packages/alchemy/src/AWS/S3/GetObject.ts), [S3 PutObject](../../../packages/alchemy/src/AWS/S3/PutObject.ts)
- [SQS SendMessage](../../../packages/alchemy/src/AWS/SQS/SendMessage.ts), [DynamoDB GetItem](../../../packages/alchemy/src/AWS/DynamoDB/GetItem.ts)
- [Kinesis PutRecord](../../../packages/alchemy/src/AWS/Kinesis/PutRecord.ts), [Lambda InvokeFunction](../../../packages/alchemy/src/AWS/Lambda/InvokeFunction.ts)
- Access-split Cloudflare capabilities: [R2 Bucket](../../../packages/alchemy/src/Cloudflare/R2/), [KV Namespace](../../../packages/alchemy/src/Cloudflare/KV/), [Queue](../../../packages/alchemy/src/Cloudflare/Queues/)

For Event Sources, see:

- [SQS QueueEventSource](../../../packages/alchemy/src/AWS/SQS/QueueEventSource.ts)
- [S3 BucketEventSource](../../../packages/alchemy/src/AWS/S3/BucketEventSource.ts)

Each capability exports its contract plus one or more implementation layers:

```ts
// 1. The Binding.Service class (the contract) + a bind alias for ergonomic use
export class PutRecord extends Binding.Service<...>()("AWS.Kinesis.PutRecord") {}
export const putRecord = PutRecord.bind;

// 2. The implementation layer — resolves the host + environment, registers the
//    binding inline (guarded by __ALCHEMY_RUNTIME__), and returns the runtime client.
export const PutRecordLive = Layer.effect(
  PutRecord,
  Effect.gen(function* () {
    const host = yield* Worker; // or the AWS Function host
    const env = yield* WorkerEnvironment; // or Lambda.FunctionEnvironment
    return Effect.fn(function* (stream: Stream) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        // AWS: { policyStatements: [...] }   Cloudflare: { bindings: [...] }
        yield* host.bind`${stream}`({ policyStatements: [...] });
      }
      return /* typed runtime client closing over `env` */;
    });
  }),
);
```

Provide the implementation layer on the **Function/Worker** Effect (`Effect.provide(PutRecordLive)`).

### Read/Write/ReadWrite binding convention

When a capability's API distinguishes access levels (R2 `head`/`get`/`list` vs `put`/`delete`; KV `get`/`getWithMetadata`/`list` vs `put`/`delete`), split it into three `Binding.Service`s so consumers can request least privilege, each with two interchangeable implementations:

- **`{Cap}Read.ts` / `{Cap}Write.ts` / `{Cap}ReadWrite.ts`** — the `Binding.Service` class + runtime client interface + a `bind` alias (e.g. `ReadBucket = BucketRead.bind`). `ReadWrite`'s client interface `extends` both the `Read` and `Write` client interfaces.
- **`{Cap}Binding.ts`** — *shared* worker-binding scaffolding: a `make{Cap}Binding({ makeClient })` that resolves `WorkerEnvironment` + host `Worker`, registers the native binding via ``host.bind`${resource}`(...)`` (guarded by `__ALCHEMY_RUNTIME__`), plus a `make{Cap}Helpers` returning the low-level `raw`/`use`/`tryPromise` primitives. **Do NOT export this file from `index.ts`.**
- **`{Cap}ReadBinding.ts` / `{Cap}WriteBinding.ts` / `{Cap}ReadWriteBinding.ts`** — `Layer.effect` implementations over the native binding (`ReadBucketBinding`, …) plus the `makeRead`/`makeWrite` client builders. `ReadWrite` composes the read + write builders.
- **`{Cap}Http.ts`** — *shared* HTTP/token scaffolding: a `makeHttp{Cap}Binding({ permissionGroups, makeClient })` that mints a scoped `AccountApiToken` with the right permission groups, binds the token's `value`/`accountId` into the Worker, and resolves the per-operation scope. **Do NOT export this file from `index.ts`.**
- **`{Cap}ReadHttp.ts` / `{Cap}WriteHttp.ts` / `{Cap}ReadWriteHttp.ts`** — `Layer.effect` implementations over the cloud's HTTP API (`ReadBucketHttp`, …). Operations the HTTP API can't support `Effect.die` with a typed error.

Rules:

- **Keep shared scaffolding internal.** Re-export only the contracts, the per-level layers, and the client builders from `index.ts`. Exporting `{Cap}Binding.ts`/`{Cap}Http.ts` leaks generic helper names into the flat `Cloudflare`/`AWS` namespace and collides across services.
- **Use service-unique helper names.** Avoid generic `makeHelpers`/`makeWrite`; prefix with the capability (`makeQueueHelpers`, `makeWriteQueueClient`) so re-exported builders never clash.
- **Namespace the public surface.** Export the service both flatly and as a namespace (`export * as KV from "./KV/index.ts"`) so callers write `Cloudflare.KV.ReadWriteNamespace(ns)`. The bind-alias callables drop the redundant service prefix (`ReadWriteNamespace`, not `ReadWriteKVNamespace`); the underlying classes/interfaces keep it (`KVNamespaceReadWrite`, `ReadWriteKVNamespaceClient`).
- **No resource-level `bind`.** The Resource is plain `Resource<T>("Cloud.Type")` with no `bind:` field; callers bind via the namespaced capability, not `resource.bind`.
- **Single-mode capabilities stay single.** A producer-only capability (e.g. Cloudflare Queue's send-only producer, which has no runtime read) ships just the `Write` service — don't invent a `Read` the runtime can't satisfy. The HTTP impl can still cover both directions where the API does.

Reference: [Cloudflare R2 Bucket](../../../packages/alchemy/src/Cloudflare/R2/), [KV Namespace](../../../packages/alchemy/src/Cloudflare/KV/), [Queue](../../../packages/alchemy/src/Cloudflare/Queues/).

### Runtime-only methods: color with `Alchemy.RuntimeContext`

The runtime callable returned by a `Binding.Service` (the inner Effect inside `.bind(resource)`'s return) **must** declare `Alchemy.RuntimeContext` as a requirement. This is how Alchemy models "this code can only run inside a deployed Function/Worker" at the type level — analogous to a colored function.

```ts
import type { RuntimeContext } from "../../RuntimeContext.ts";

export class GetItem extends Binding.Service<
  GetItem,
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: GetItemRequest,
    ) => Effect.Effect<
      DynamoDB.GetItemOutput,
      DynamoDB.GetItemError,
      RuntimeContext // ← runtime-only
    >
  >
>()("AWS.DynamoDB.GetItem") {}
```

Rules:

- **Outer Effect** (the `bind(resource)` setup) runs at the Function's init phase. It does NOT require `RuntimeContext`.
- **Inner Effect** (the actual SDK invocation) only makes sense inside a running Function. It MUST require `RuntimeContext`.
- Resolve cloud-environment services (`WorkerEnvironment`, AWS SDK clients, etc.) once during Layer construction and close over them. Do NOT leak `WorkerEnvironment` / `Lambda.FunctionEnvironment` onto the runtime callable — that couples downstream service code to a specific cloud and breaks Layer encapsulation. The Function/Worker runtime satisfies `RuntimeContext` automatically.
- The implementation can return `Effect.Effect<A, E>` without explicitly providing `RuntimeContext` (it's contravariant in `R`); just declare it on the interface.

Why this matters: consumers can build cloud-agnostic services on top of bindings using `Layer.effect(Tag, ...)` without polluting their service interface with `WorkerEnvironment`. See [Layers concept](../../../website/src/content/docs/infrastructure-as-effects/layers.mdx).

After implementing, re-export the contract and implementation layers from the service's `index.ts` (but keep the shared `{Cap}Binding.ts`/`{Cap}Http.ts` scaffolding un-exported).

### Isolate scope vs request scope (runtime bridges)

**Layer construction is isolate-scoped; the effects built services expose are request-scoped.**

- **At layer build / Worker init (instance scope)** a layer MAY resolve services and env/config, register listeners and `bind` declarations, assemble `Effect.fn` clients, and perform one-shot I/O that produces a plain cached value (e.g. fetch a secret and cache it for a client). It MUST NOT acquire **disposable** resources — connections, pools, streams, anything with a finalizer (`Layer.scoped` / `Effect.acquireRelease` / init-level `Effect.addFinalizer`) — or retain I/O-backed *objects* or promises across events (workerd pins them to the creating request's IoContext). The runtime bridges (Worker event, Durable Object call, Workflow run, Lambda invoke) build the layer stack **once per instance** on the first event. Instance finalizers run at instance shutdown at best: **never on workerd** (no teardown hook), and in a **best-effort 500 ms SIGTERM window on Lambda** (the generated entry registers an internal extension to obtain it and closes the instance scope on SIGTERM; not delivered on hard failures). Server processes (Containers, ECS Tasks) close their root scope on graceful exit.
- **At request scope**, anything needing I/O or cleanup is an effect requiring `Scope.Scope`, acquired lazily per call. Every bridge provides a fresh `Scope` per event; `Effect.addFinalizer` in a handler attaches to it and runs after the response (registered with `ctx.waitUntil` on workerd; settled inline on Lambda). Per-request memoization keys on the scope object (`yield* Effect.scope`) — see [Drizzle/Postgres.ts](../../../packages/alchemy/src/Drizzle/Postgres.ts) for the canonical WeakMap pattern. One pool/socket per event is the law on workerd (sockets are IoContext-pinned); Hyperdrive is the cross-request pooler.

:::tip
If you need to know what AWS region or account ID the resource is being created/updated in, you can use this inside any of the lifecycle operations.

```ts
const region = yield * Region;
const account = yield * Account;
```

:::

:::warning
You should favor getting the region/account INSIDE the lifecycle operations instead of inside the Layer effect like this because then it's scoped to the resource isntead of the resource provider:

```ts
reconcile: Effect.fn(function* ({ id, news, output, session }) {
  const { accountId, region } = yield* AWSEnvironment.current;
});
```

:::

:::warning
Do not use `Effect.orDie` in the lifecycle operations since this will crash the whole IaC engine.
:::

:::warning
**Never use `async`/`await`, raw `Promise`, `node:fs/promises`, `node:fs`, `node:os`, or `pathe` directly in resource code.** Always use the Effect platform services so that effects remain composable, traceable, retryable, and testable:

| Don't                                                | Do                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `import fs from "node:fs/promises"`                  | `const fs = yield* FileSystem.FileSystem`                   |
| `await fs.readFile(p, "utf8")`                       | `yield* fs.readFileString(p)`                               |
| `await fs.mkdtemp(...)`                              | `yield* fs.makeTempDirectory({ prefix: ... })`              |
| `import path from "pathe"` / `node:path`             | `const path = yield* Path.Path`                             |
| `await fetch(...)`                                   | `yield* HttpClient.HttpClient` + `HttpClientRequest`        |
| `Effect.promise(() => listSqlFiles(dir))`            | Make `listSqlFiles` itself return `Effect` and `yield*` it |
| `new Promise((res) => setTimeout(res, ms))`          | `yield* Effect.sleep(Duration.millis(ms))`                  |

Sync, CPU-only Node APIs (e.g. `crypto.createHash().update().digest()`, `process.cwd()`, `Buffer`, `TextEncoder`) must still be wrapped in `Effect.sync(() => ...)` (or `Effect.try` if they can throw) so the call participates in the Effect runtime — tracing, interruption, and error channels. Don't call them as bare expressions inside `Effect.gen`.

```ts
const hash = yield* Effect.sync(() =>
  crypto.createHash("sha256").update(input).digest("hex"),
);
const cwd = yield* Effect.sync(() => process.cwd());
```

This applies to **lifecycle operations, helpers, AND tests**. Tests must use `FileSystem.FileSystem`/`Path.Path` for any file/path access (see [Database.test.ts](../../../packages/alchemy/test/Cloudflare/D1/Database.test.ts) for the pattern).
:::

:::tip
If a Resource supports tags, you should always include the internal Alchemy tags to brand the resource with the app, stage and logical ID so that we can "know" that we created it and are responsible for it.

```ts
reconcile: Effect.fn(function* ({ id, news, output, session }) {
  const internalTags = yield* createInternalTags(id);
  const userTags = news.tags ?? {};
  const allTags = { ...internalTags, ...userTags };
});
```

:::

:::warning
Do not roll your own tag diffing logic, always use `diffTags` from [Tags.ts](../../../packages/alchemy/src/Tags.ts), and diff against **observed cloud tags** (not `olds.tags` or `output.tags`). Adoption can hand you a resource whose tags don't match what we last persisted.

```ts
reconcile: Effect.fn(function* ({ id, news, output, session }) {
  const internalTags = yield* createInternalTags(id);
  const newTags = { ...news.tags, ...internalTags };
  // Read tags fresh from the cloud so adoption (where tags may not match
  // what we last persisted) converges correctly.
  const oldTags = yield* fetchObservedTags(/* … */);
  // Option 1. use `upsert` if the API expects you to create/update tags in one call
  const { removed, upsert } = diffTags(oldTags, newTags);
  // Option 2. use `added` and `updated` if the API expects you to create/update tags in separate calls
  const { removed, added, updated } = diffTags(oldTags, newTags);
  // Option 3. use `upsert` only if the API doesn't expect you to remove tags (only PUT/UPDATe)
  const { upsert } = diffTags(oldTags, newTags);
```

:::

9. Implement the test cases in `packages/alchemy/test/{Cloud}/{Service}/{Resource}.test.ts`.

Read through the established test cases before continuing so that you understand the pattern and structure of the test cases.

- [S3 Bucket Test Cases](../../../packages/alchemy/test/AWS/S3/Bucket.test.ts)
- [SQS Queue Test Cases](../../../packages/alchemy/test/AWS/SQS/Queue.test.ts)
- [Lambda Function Test Cases](../../../packages/alchemy/test/AWS/Lambda/Function.test.ts)
- [Kinesis Stream Test Cases](../../../packages/alchemy/test/AWS/Kinesis/Stream.test.ts)
- [DynamoDB Table Test Cases](../../../packages/alchemy/test/AWS/DynamoDB/Table.test.ts)
- [VPC Test Cases](../../../packages/alchemy/test/AWS/EC2/Vpc.test.ts)
- [Subnet Test Cases](../../../packages/alchemy/test/AWS/EC2/Subnet.test.ts)

:::warning
Never use `Date.now()` when constructing the physical name of a resource. You should either:

1. Do not proide a name and rely on the resource provider to generate a unique name for you from the app, stage and logical ID.
2. Construct a deterministic one unique to each test case. But it should be the same on each subsequent run of the test case.
   :::

3. Consider implementing an aggregate Smoke test that brings together multiple resources that are often used together.

See the [VPC Smoke Test](../../../packages/alchemy/test/AWS/EC2/Vpc.smoke.test.ts) for an example.
