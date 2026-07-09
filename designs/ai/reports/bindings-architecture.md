# The Binding.Service Architecture — end-to-end report

> Research report for the AI EventSource redesign. All paths relative to
> `packages/alchemy` unless noted. Line numbers verified against the working
> tree on 2026-07-08.

---

## 1. The binding pattern, end to end

The lifecycle of one binding — using `Cloudflare.R2.ReadBucket(bucket)` as the
running example — is a single `yield*` that does different work depending on
which phase the same code is executing in.

### 1.1 Declare (pure contract)

A binding contract is a `Binding.Service` — a hybrid value that is at once a
Context tag, a callable, and a type (`src/Binding.ts:28-50`):

```20:28:packages/alchemy/src/Cloudflare/R2/ReadBucket.ts
export interface ReadBucket extends Binding.Service<
  ReadBucket,
  "Cloudflare.R2.ReadBucket",
  (bucket: Bucket) => Effect.Effect<ReadBucketClient>
> {}

export const ReadBucket = Binding.Service<ReadBucket>(
  "Cloudflare.R2.ReadBucket",
);
```

The contract file contains **zero behavior** — just the tag and the client
interface (`ReadBucketClient`, `src/Cloudflare/R2/ReadBucket.ts:30-44`, every
method colored with `RuntimeContext`).

### 1.2 Interpolate / yield (requirement bubbles)

Calling the tag produces an Effect whose `R` includes the tag itself
(`src/Binding.ts:43-49`):

```43:49:packages/alchemy/src/Binding.ts
  <Req = never>(
    ...args: BindParameters<Parameters<Shape>, Req>
  ): Effect.Effect<
    Effect.Success<ReturnType<Shape>>,
    Effect.Error<ReturnType<Shape>>,
    Self | Effect.Services<ReturnType<Shape>> | Req
  >;
```

The callable half is `tag.use((f) => f(...resolvedArgs))`
(`src/Binding.ts:66-72`), so `yield* ReadBucket(bucket)` requires `ReadBucket`
in context, resolves the stored implementation function, and applies it. This
is exactly how "declaring the capability" becomes a type-level Layer
requirement.

### 1.3 Plan-time registration (`host.bind`)

The implementation Layer's body runs during the host's **init phase** — which
executes both at plan time and at runtime module init (see §1.6). At plan time
the `__ALCHEMY_RUNTIME__` guard is falsy, so the deploy-time half runs
(`src/Cloudflare/R2/BucketBinding.ts:24-40`):

```24:40:packages/alchemy/src/Cloudflare/R2/BucketBinding.ts
    return Effect.fn(function* (bucket: Bucket) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`${bucket}`({
          bindings: [
            {
              type: "r2_bucket",
              name: bucket.LogicalId,
              bucketName: bucket.bucketName,
              ...
```

`host.bind` is defined per-resource in the `Resource` constructor
(`src/Resource.ts:244-300`): it pushes `{ sid, data }` onto
`stack.bindings[host.FQN]` (`src/Resource.ts:250-257`). The template form
(`` host.bind`${bucket}` ``) stringifies the interpolations into a
deterministic **sid** — resources render as their `LogicalId`
(`src/Resource.ts:277-279`). The sid is the binding's identity: duplicates
collapse by sid (`src/Diff.ts:143-154`, `dedupeBindings` keeps the last
occurrence per sid; `diffBindings` at `src/Diff.ts:156-186` keys its diff Map
the same way).

The `__ALCHEMY_RUNTIME__` guard is a build-time constant: the bundler folds it
to `true` in deployed artifacts, so the whole plan-time branch is
dead-code-eliminated from the Worker/Lambda bundle (`src/Phase.ts:4-18`).

### 1.4 Provision (bindings reach `reconcile`)

The plan resolves `stack.bindings[fqn]` (`src/Plan.ts:674-678`, deduped) and
the apply phase evaluates the binding Outputs and hands them to the provider
(`src/Apply.ts:640-654`):

```640:650:packages/alchemy/src/Apply.ts
        const bindingOutputs = excludeDeletedBindings(
          yield* Output.evaluate(node.bindings, outputs),
        );

        attr = yield* node.provider
          .reconcile({
            id: logicalId,
            fqn,
            news,
            instanceId,
            bindings: bindingOutputs,
```

`bindings` is a declared parameter of `reconcile`/`precreate`/`delete`
(`src/Provider.ts:256-269`). The Worker provider flattens them into workerd
metadata bindings: `bindings.flatMap((b) => b.data.bindings ?? [])`
(`src/Cloudflare/Workers/WorkerProvider.ts:1221`), and serializes `props.env`
entries as `plain_text`/`secret_text` bindings
(`WorkerProvider.ts:1296-1315`). Bindings also participate in the dependency
graph (`src/Plan.ts:551-560` — binding upstreams) which is what allows
*circular* references between resources.

### 1.5 Runtime readback (`Output.named` / env accessors)

The runtime half of a binding closes over accessors produced by the Output
machinery. `yield* someOutput` on any Output runs `asEffect()` → `bind(id)`
(`src/Output.ts:114-135`):

```127:135:packages/alchemy/src/Output.ts
  public bind(id: string): any {
    // `set`/`get` store keys verbatim, so canonicalize here (the caller's job).
    const key = sanitizeKey(id);
    return RuntimeContext.pipe(
      Effect.flatMap((ctx) =>
        Effect.map(ctx.set(key, this), (k) => ctx.get<A>(k)),
      ),
    );
  }
```

One expression, two phases:

- **Plan**: `ctx.set(key, output)` on the Worker's runtime context stores the
  Output expression into the pending `env` record
  (`src/Cloudflare/Workers/WorkerRuntimeContext.ts:67-88` — serializing
  `Redacted` values with a `{_tag: "Redacted"}` marker so they deploy as
  `secret_text`).
- **Runtime**: the returned accessor `ctx.get<A>(key)` reads the *deployed*
  value back off `WorkerEnvironment` and rebuilds the `Redacted` wrapper
  (`WorkerRuntimeContext.ts:37-66`).

`Output.named(expr, "SOME_KEY")` (`src/Output.ts:324-341`) just overrides the
derived key (`BaseExpr` derives the key from `toString()`), making the env-var
name deterministic and caller-controlled. `Output.interpolate` builds a
string-composing Output (`src/Output.ts:464-474`). Simple attribute reads use
the same machinery: `const QueueUrl = yield* queue.queueUrl` in
`src/AWS/SQS/SendMessageHttp.ts:17` registers the env key
`Queue.queueUrl` at plan time and returns the runtime accessor.

### 1.6 The host's init effect runs in both phases

`Platform.make` (`src/Platform.ts:359-510`) is what runs the user's init
Effect. It constructs the resource, then runs `impl` with a Layer stack that
provides `RuntimeContext`, `Self`, the host tag, and (plan-phase only) the
`planServices` (`src/Platform.ts:456-491`; phase-gated at 476-486, e.g. a
stub `WorkerEnvironment` + deferred execution context from
`WorkerRuntimeContext.ts:113-119`). After the init effect completes, the env
accumulated by all the `ctx.set` calls is folded into the resource's Props
(`src/Platform.ts:494-503`):

```494:503:packages/alchemy/src/Platform.ts
              instance.Props = {
                ...props,
                env: {
                  ...props?.env,
                  ...runtimeContext.env,
                },
                exports: runtimeContext.exports
                  ? yield* runtimeContext.exports
                  : undefined,
              };
```

At runtime, the *same* init effect runs during module init inside the deployed
Worker — the guard skips the deploy half, `ctx.get` resolves against the real
`WorkerEnvironment`, and `ctx.listen`ers become the exported handler
dispatchers (`WorkerRuntimeContext.ts:120-178`).

### 1.7 Runtime callable

The client returned by the binding closes over the resolved environment and is
colored with `RuntimeContext` so it can only *run* inside a deployed handler
(`src/Cloudflare/R2/ReadBucket.ts:30-44`; `RuntimeContext` itself is
`src/RuntimeContext.ts:51-56`, with `RuntimeContext.phantom` for tests).

**Summary picture:**

```
contract tag (pure)          ReadBucket.ts — Binding.Service, client interface
      │ yield* ReadBucket(bucket)         ← requirement bubbles into R
implementation Layer         ReadBucketBinding / ReadBucketHttp (same tag)
      │ init phase, plan:  host.bind`${bucket}`({bindings|policyStatements})
      │                    → stack.bindings[host.FQN] (sid-keyed)
      │                    Output yields → ctx.set → Props.env
      ▼
provider.reconcile({ bindings, news })     Apply.ts:640-654
      │ deploys native bindings / IAM / env vars
      ▼
runtime module init (guard = true): ctx.get accessors, ctx.listen handlers
      │
runtime callable (RuntimeContext-colored client)
```

---

## 2. Answers to the six questions

### Q1 — Anatomy of a Binding.Service

- **Class declaration**: `interface X extends Binding.Service<X, Id, Shape>` +
  `const X = Binding.Service<X>(Id)` (`src/Binding.ts:35-74`). The factory
  wraps a `Context.Service` tag in a Proxy (`taggedFunction`,
  `src/Util/effect.ts:35-50`) that forwards the Effect protocol to the tag
  while remaining directly callable. Callable arguments accept
  `Input<T> | Effect<T>` (`BindParameters`, `src/Binding.ts:18-26`) and are
  resolved before the impl runs (`src/Binding.ts:66-72`).
- **Two-phase structure**: the Layer's construction Effect (outer) resolves
  the host + environment once — `yield* WorkerEnvironment; yield* Worker`
  (`src/Cloudflare/R2/BucketBinding.ts:20-22`) — and returns
  `Effect.fn(function* (resource) { ... })`, which is the per-resource bind
  Effect. *Inside that*: guarded deploy-time registration, then construction
  of the runtime client (`BucketBinding.ts:24-43`).
- **`Alchemy.RuntimeContext`** appears on the runtime *client's* method
  signatures, not on the bind Effect: `ReadBucketClient.head/get/list` each
  return `Effect<..., R2Error, RuntimeContext>`
  (`src/Cloudflare/R2/ReadBucket.ts:30-44`).
  **Doctrine divergence**: AGENTS.md ("Runtime-only methods: color with
  `Alchemy.RuntimeContext`") shows `AWS.DynamoDB.GetItem` colored with
  `RuntimeContext`, but the actual AWS bindings do **not** declare it —
  `src/AWS/DynamoDB/GetItem.ts:29-40`, `src/AWS/S3/GetObject.ts:9-21`, and
  `src/AWS/SQS/SendMessage.ts:12-24` all return plain
  `Effect<Out, Err>` runtime callables (`rg "RuntimeContext"` finds no match in
  those files). The Cloudflare capability clients follow the doctrine; the AWS
  ones don't.
- **Host resolution**: Cloudflare impls resolve the concrete host tag
  (`yield* Worker`, `BucketBinding.ts:22`); AWS impls resolve the generic
  `Binding.Host` (`Self` cast to `Effect<ResourceLike>`,
  `src/Binding.ts:76-84`) and *narrow* it — `if (isFunction(host))`
  (`src/AWS/S3/GetObjectHttp.ts:17-19`) or
  `if (isFunction(host) || isInstance(host))`
  (`src/AWS/SQS/SendMessageHttp.ts:18-20`) — so one Layer serves multiple host
  kinds.
- **What `` host.bind`${resource}`(data) `` records and when**: at plan time
  (only — the guard) it appends `{ sid, data }` to `stack.bindings[host.FQN]`
  (`src/Resource.ts:250-257`), where `sid` is the rendered template
  (`src/Resource.ts:258-300`). `data` must conform to the host's **Binding
  Contract** (4th type param of `Resource`; declared for Worker as
  `{ bindings: WorkerBinding[] }`-shaped data, for Lambda as
  `{ env?, policyStatements? }`). Nothing is deployed at that moment — the
  data flows into `provider.reconcile`'s `bindings` parameter on the next
  apply (`src/Apply.ts:640-654`, `src/Provider.ts:268`).

### Q2 — Deploy-time vs runtime split

Covered in §1.3–§1.6. The crucial mechanics:

- One `yield*` does both halves because the **same init Effect runs twice** —
  once during plan (guard falsy → register bindings, `ctx.set` env) and once
  during runtime module init (guard folded to `true` → only build accessors
  and listeners). `src/Phase.ts:4-18` documents the fold;
  `src/Platform.ts:359-510` is the shared execution path.
- `Output.named` readback: the GitHub webhook secret is the canonical example
  (`src/Cloudflare/Workers/GitHubRepositoryEventSource.ts:75-80`) — plan
  registers a `secret_text` binding under a deterministic key
  (`webhookSecretEnvName`, `src/GitHub/RepositoryEventSource.ts:185-188`),
  runtime reads it back as `Effect<Redacted<string>>`.
- `bindings` → `reconcile`: deduped by sid at plan (`src/Plan.ts:674-678`),
  Output-evaluated at apply (`src/Apply.ts:640-642`), consumed by the provider
  (`WorkerProvider.ts:1221` for native bindings; Lambda merges
  `policyStatements` into the role; S3's provider consumes
  `notificationConfiguration` bindings, etc.).

### Q3 — How requirements bubble

`yield* Cloudflare.R2.ReadBucket(bucket)` inside a Worker init Effect puts
**the tag `ReadBucket` itself** in the Effect's `R` (`src/Binding.ts:48`).
It is satisfied by `Effect.provide(ReadBucketBinding)` on the Worker's init
Effect (the doc example at `website/src/content/docs/infrastructure-as-effects/binding.mdx:17-30`).

Interchangeable impls share one contract tag because both are
`Layer.effect(ReadBucket, …)`:

- native: `ReadBucketBinding = Layer.effect(ReadBucket, makeBucketBinding({makeClient: makeRead}))`
  (`src/Cloudflare/R2/ReadBucketBinding.ts:11-14`);
- HTTP: `ReadBucketHttp = Layer.effect(ReadBucket, makeHttpBucketBinding({permissionGroups: ["Workers R2 Storage Read"], …}))`
  (`src/Cloudflare/R2/ReadBucketHttp.ts:27-35`), which mints a scoped
  `AccountApiToken` and binds its value into the host
  (`src/Cloudflare/R2/BucketHttp.ts:19-47`).

The Layer's own requirements are what pin it to a platform: the native layer
needs `WorkerEnvironment | Worker`, so providing it to a Lambda is a compile
error (`binding.mdx:81-99` explains this; verified by
`BucketBinding.ts:20-22`).

**File-layout divergence from AGENTS.md**: the doctrine names files
`BucketRead.ts`/`BucketReadBinding.ts`/…; the code uses
`ReadBucket.ts`/`ReadBucketBinding.ts`/`ReadBucketHttp.ts` (verb-first), same
for KV (`ReadNamespace.ts`, …) and Queues (`WriteQueue.ts`, producer-only as
doctrine predicts — `src/Cloudflare/Queues/` has no ReadQueue). The shared
scaffolding files (`BucketBinding.ts`, `BucketHttp.ts`, `NamespaceBinding.ts`,
`QueueBinding.ts`) exist exactly as documented and are not exported.
Also: AGENTS.md refers to `website/.../concepts/layers.mdx`; the actual docs
live under `website/src/content/docs/infrastructure-as-effects/`
(`binding.mdx`, `layers.mdx`, `event-sources.mdx`, `phases.mdx`,
`circular-bindings.mdx`).

### Q4 — Event-source bindings

Event sources are **not** `Binding.Service`s of the host-capability kind (with
one exception, below). The established shape is a *plain `Context.Service`
contract in the resource's package* + *a host-specific `Layer.effect`
implementation in the runtime's package*:

**Contract** (`src/GitHub/RepositoryEventSource.ts`):

- `RepositoryEventSourceProps` (`:62-87`) — pure config: `owner`,
  `repository`, `events?`, `secret?`, `path?`. No behavior.
- `consumeRepositoryEvents(props, process)` (`:123-155`) — ergonomic helper
  that does `RepositoryEventSource.use((source) => source(props, process))`;
  its return type is `Effect<void, never, RepositoryEventSource>` — the
  **contract tag is the requirement** that bubbles into the Worker init's `R`.
- `webhookPath(props)` (`:177-178`) and `webhookSecretEnvName(repo)`
  (`:185-188`) — deterministic derivations shared by both halves so
  deploy-time registration and runtime claiming agree.

**Cloudflare Live layer**
(`src/Cloudflare/Workers/GitHubRepositoryEventSourceLive`,
`src/Cloudflare/Workers/GitHubRepositoryEventSource.ts:34-98`), walked:

1. `:37` — `const ctx = yield* Worker` (host resolution; this Layer only
   composes onto a Worker).
2. `:41` — `const createWebhook = yield* Webhook` (yields the *resource
   class*, erasing its `GitHub.Providers` requirement — satisfied by the
   stack at plan time; comment at `:38-40`).
3. `:43-46` — returns the service function `(props, process) => Effect`.
4. `:53-67` — **deploy-time half**, guarded: `Namespace.push(ctx.LogicalId, …)`
   then `createWebhook(`${owner}/${repo}`, { owner, repository, url:
   Output.interpolate`${ctx.url}${path}`, events, secret, contentType })`.
   The webhook is a real `Resource` (`src/GitHub/Webhook.ts:63-94,137`) whose
   provider reconciles observe→ensure→sync against the GitHub API
   (`Webhook.ts:143-207`). Namespacing under the host's LogicalId gives it an
   FQN like `Org/alchemy-run/alchemy-effect` (`src/FQN.ts:52-59`).
5. `:75-80` — the secret is bound via
   `Output.named(Output.asOutput(props.secret), webhookSecretEnvName(props))`;
   this single `yield*` registers the `secret_text` env binding at plan time
   and returns the runtime accessor (comment at `:69-74` says exactly this).
6. `:82-96` — **runtime half** (unguarded — runs in both phases, but
   listeners only matter at runtime): `ctx.listen((event) => …)` claims fetch
   events whose pathname equals the deterministic `webhookPath`; anything else
   returns `undefined` and falls through to the Worker's own `fetch`.
   `ctx.listen` just pushes the handler into the runtime context's listener
   array (`WorkerRuntimeContext.ts:99-108`); the exported `default` handler
   dispatches every event to every listener and uses whichever returns an
   Effect (`WorkerRuntimeContext.ts:126-161`).
7. `:101-150` — `handleDelivery`: method check → body read → HMAC-SHA256
   verification against the bound secret (`:118-129`, constant-time compare
   `:188-195`) → parse → `yield* process(delivery).pipe(Effect.orDie)`
   (`:147`) → 202.

**AWS SQS QueueEventSource** — contract `src/AWS/SQS/QueueEventSource.ts:54-78`
(a plain `Context.Service` again; `consumeQueueMessages` helper at `:33-52`);
impl `src/AWS/Lambda/QueueEventSource.ts:22-87`: resolves `Lambda.Function`
host + the `EventSourceMapping` resource class (`:28-29`); guarded deploy half
(`:42-72`) does `Namespace.push(host.LogicalId, …)` wrapping (a) an IAM grant
via `` host.bind`Allow(${host}, AWS.Lambda.QueueEventSource(${queue}))` ``
with `sqs:ReceiveMessage/DeleteMessage/GetQueueAttributes` on the queue ARN,
and (b) creation of the `EventSourceMapping` resource
(`` Mapping(`${queue.LogicalId}-EventSource`, { functionName, eventSourceArn,
batchSize, … }) ``, `:62-69`); runtime half registers `host.listen` filtering
`isSQSEvent` (`:74-84`).

**AWS S3 BucketEventSource** — contract `src/AWS/S3/BucketEventSource.ts:12-32`
(note: this one *is* declared via `Binding.Service` — the exception — though
it's used exactly like the Context.Service event sources); impl
`src/AWS/Lambda/BucketEventSource.ts:37-135`: deploy half creates a Lambda
`Permission` child resource (`:80-88`) **and pushes a binding onto the
*bucket*** — `bucket.bind("AWS.S3.Notifications(…)", { notificationConfiguration:
{ LambdaFunctionConfigurations: [...] } })` (`:89-101`) — which the Bucket
provider unions into its notification config at reconcile. This is the
established pattern for "consumer requests configuration on another resource"
(same as DynamoDB Streams per `src/AWS/AGENTS.md`).

**CronEventSource** (`src/Cloudflare/Workers/CronEventSource.ts`) — contract
`:208-218`, helper `cron()` `:201-206`, Live `:220-254`. Deploy half is a pure
host binding: `` host.bind(`Cron(${expression})`, { crons: [expression] }) ``
inside `Namespace.push` (`:234-241`) — no child resource; the Worker provider
unions all `crons` binding entries. Runtime half filters scheduled events by
`controller.cron === expression` (`:244-251`).

### Q5 — The definition-data question

In every existing event source, the "declaration" is **pure config data**:

- `RepositoryEventSourceProps` (`src/GitHub/RepositoryEventSource.ts:62-87`) —
  owner/repository/events/secret/path. Plain fields, one `Redacted`.
- `QueueEventSourceProps` / `MessagesProps`
  (`src/AWS/SQS/QueueEventSource.ts:9-20,59-70`) — batchSize etc.
- `NotificationsProps` (S3), a cron `expression` string (Cron).
- Deterministic *derivations* from props (`webhookPath`,
  `webhookSecretEnvName`) live next to the props as pure functions.

Behavior lives exclusively in the Layer. **There is no existing case where a
declaration object carries an effect.** The closest things to "behavior on a
declaration" are (a) the `process` handler the *consumer* passes (a callback,
not part of the source's identity), and (b) `Output` expressions inside props
(pure expression trees, evaluated by the engine — `src/Output.ts:567-682` —
not user-authored provisioning effects). The rejected `wire` field
(`src/AI/EventSource.ts:70-74` — "an Effect, evaluated by the kernel in the
host's init phase, that provisions the delivery infrastructure") has no
precedent anywhere in the codebase. The doctrine holds: **declaration = data;
provisioning + delivery = the per-cloud Layer.**

### Q6 — Dedupe across multiple consumers

Three dedupe mechanisms exist today:

1. **Resource FQN dedupe** — the primary one for event sources. The
   `Resource` constructor returns the existing instance if the FQN is already
   registered (`src/Resource.ts:239-243`). Because
   `GitHubRepositoryEventSourceLive` namespaces the webhook under the host and
   uses the deterministic id `${owner}/${repository}`
   (`GitHubRepositoryEventSource.ts:54-57`), two `consumeRepositoryEvents`
   calls for the same repo on the same Worker produce the same FQN and only
   **one** `Webhook` resource. **Caveat**: props are *not* compared — the
   comment at `src/Resource.ts:241` reads
   `// TODO(sam): check if props are different and die`. So if the second
   subscription asks for different `events`, the first call's event list
   silently wins. There is no union-of-events mechanism at the resource level.
2. **Binding sid dedupe** — `stack.bindings[fqn]` entries collapse by sid,
   last wins (`src/Diff.ts:143-154`; applied at `src/Plan.ts:316-321` and
   `:674-678`). Deterministic sid templates
   (`` `Allow(${host}, AWS.S3.GetObject(${bucket}))` ``) are what make two
   identical capability binds idempotent. Where union (not dedupe) is wanted,
   each consumer pushes a *distinct* sid and the **provider** unions the data
   — Cron pushes one `Cron(${expression})` binding per expression and the
   Worker provider merges all `crons`; S3 notifications and DynamoDB stream
   bindings union the same way.
3. **Runtime listener fan-out** — every `ctx.listen` handler sees every event
   (`WorkerRuntimeContext.ts:136-142`). Two subscribers to the same repo each
   register a listener on the same `webhookPath`; both `process` handlers run.
   Note the dispatch edge: with >1 responding listener the effects run under
   `Effect.all({ discard: true })` (`WorkerRuntimeContext.ts:146-154`), so
   for `fetch` events the Response is discarded — duplicate *path claims* are
   not well-defined today (fine for scheduled/queue events, questionable for
   fetch). A redesigned channel layer should claim each path exactly once.

---

## 3. Redesign proposal: AI EventSource in the binding idiom

### 3.1 What the pieces map to

| binding idiom (existing)                                  | AI EventSource (proposed)                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| `RepositoryEventSourceProps` (pure config)                 | `EventSource<In, Channel>` datum: `{ name, schema, props }`      |
| contract tag (`RepositoryEventSource` Context.Service)     | one channel tag per event *family* (`GitHubEvents`)              |
| requirement bubbling (`Effect<void, never, Tag>`)          | `Trigger<In, Channels>` → `RefServices` → loop `Req` (unchanged) |
| per-cloud Live layer (`GitHubRepositoryEventSourceLive`)   | `GitHubEventsLive` (Cloudflare): provisions + delivers           |
| `host.bind` / child resource inside `Namespace.push`       | `Webhook` resources, FQN-deduped per (repo, event)               |
| `ctx.listen` claiming `webhookPath`                        | one listener per repo path, verify → decode → ring inbox         |
| kernel resolving tool refs from ambient context (§2.2)     | kernel resolving `source.channel` tag and calling `subscribe`    |

### 3.2 The pure definition data

Delete `wire` and `WireReq`. An `EventSource` becomes exactly what a
`RepositoryEventSourceProps` is — data plus a schema plus the channel tag
*handle* (a tag reference is data, like a class object; it carries no
behavior):

```ts
// src/AI/EventSource.ts (redesigned)
export interface EventSource<In = unknown, Channel = never, Props = unknown> {
  "~alchemy/Kind": "EventSource";
  /** Deterministic identity, e.g. "github.issues.opened/owner/repo". */
  "~alchemy/Name": string;
  /** Phantom carrier for the channel tag. */
  "~alchemy/Channel": Channel;
  schema: S.Top & { readonly Type: In };
  /** The channel tag's runtime handle; undefined = kernel-internal (tests). */
  channel: Context.Service<any, EventChannelService> | undefined;
  /** Pure, family-specific config (repo ref, label filter, branch filter…). */
  props: Props;
}
```

`EventChannelService.subscribe` keeps its current shape
(`src/AI/EventSource.ts:22-26`) — `subscribe(source) =>
Effect<Stream<In>>` — and becomes the analogue of a Binding.Service's
`bind(resource)`: **one call, two halves**, guarded internally by
`__ALCHEMY_RUNTIME__` exactly like `BucketBinding.ts:25` /
`GitHubRepositoryEventSource.ts:53`.

### 3.3 Contract tag granularity: per event family

One tag per family (`GitHubEvents`, `DiscordEvents`), as the fixtures already
do (`test/AI/fixtures/org/github-events.ts:28-31`). Rationale, from the
existing code: `RepositoryEventSource` is one tag for *all* GitHub repo events
(`src/GitHub/RepositoryEventSource.ts:167-170`) — per-source tags would
explode the Layer graph and defeat the family-level dedupe the Live layer
needs to perform (it must see all subscriptions for a repo to share one
webhook). Per-*cloud-provider* granularity would be too coarse: a Discord
gateway connection and a GitHub webhook have nothing in common.

### 3.4 `Req` typing (unchanged mechanics, minus WireReq)

`AI.on(Github.IssueOpened(repo))` produces
`Trigger<IssueOpenedEvent, GitHubEvents>`; drop the
`| Sources[number]["~alchemy/WireReq"]` union member from `on`
(`src/AI/Trigger.ts:55`). `RefServices` already routes
`Trigger<any, infer Channels> → Channels` (`src/AI/Services.ts:50-51`), so the
loop's `Req` contains `GitHubEvents`, `AI.layer(Flywheel)` demands it
(`src/AI/Kernel.ts:121-140`), and **forgetting the Layer is a compile error at
the `Layer.provide` seam** — same failure mode as forgetting
`ReadBucketBinding` on a Worker. The second compile fence is transitive:
`GitHubEventsLive` itself requires `GitHub.RepositoryEventSource`, so
forgetting `GitHubRepositoryEventSourceLive` on the Worker also fails to
type-check (this is already how the org fixture wires it:
`test/AI/fixtures/org/cloudflare/worker.ts:122-132`).

### 3.5 How trigger sources reach the Layer

Mirror §2.2 of the design (terms bind to implementations by resolving tags
from ambient context — `designs/ai/alchemy-ai-design.md:438-459`) and how
Worker init effects register bindings today:

- `AI.layer(term)`'s init Effect runs inside the Worker's init phase (it is
  provided onto the Worker Effect — `worker.ts:195`), i.e. in exactly the
  dual-phase context where `subscribe` can do deploy-time work.
- `kernel.loop(term)` walks `term.refs`, extracts `Trigger` refs
  (`isTrigger`, `src/AI/Trigger.ts:81-86`), and for each `EventSource` with a
  `channel` handle resolves the tag from ambient context and subscribes:

```ts
// inside the Kernel's loop(term) interpretation (init phase)
for (const trigger of term.refs.filter(isTrigger)) {
  for (const source of trigger.sources.filter(isEventSource)) {
    if (source.channel === undefined) continue; // kernel-internal
    const channel = yield* source.channel;       // tag resolved from context
    const stream = yield* channel.subscribe(source);
    // wire `stream` into the ring's admission ledger (dedupe by delivery id)
  }
}
```

This is legitimate because `kernel.loop`'s requirement channel already carries
the term's `Req` (`src/AI/Kernel.ts:79-85`) — the channel tag is *provably* in
context by the time this runs. The kernel never names `GitHubEvents`
statically; it resolves whatever tag the source datum references, the same way
it resolves tool refs.

### 3.6 The Cloudflare Live layer

`subscribe` is the two-phase bind. Sketch, following
`GitHubRepositoryEventSourceLive` line by line:

```ts
// src/org/cloudflare/events.ts (redesigned; no hardcoded repos)
export const GitHubEventsLive = Layer.effect(
  GitHubEvents,
  Effect.gen(function* () {
    const rings = yield* Ring;
    // reuse the existing event-source contract — its Cloudflare impl
    // (GitHubRepositoryEventSourceLive) provisions the Webhook resource
    // and claims the delivery path; this layer only adds AI routing.
    const consume = yield* GitHub.RepositoryEventSource;

    // one PubSub per source name; deliveries fan out to subscriber streams
    const hubs = new Map<string, PubSub.PubSub<unknown>>();
    // claimed (owner/repo/event) wires — dedupe within this layer instance
    const wired = new Set<string>();

    return GitHubEvents.of({
      subscribe: Effect.fn(function* (source) {
        const { repo, event } = source.props as GitHubSourceProps;
        const wireKey = `${repo.owner}/${repo.repository}#${event}`;

        if (!wired.has(wireKey)) {
          wired.add(wireKey);
          // BOTH halves happen inside consume(): at plan time
          // GitHubRepositoryEventSourceLive provisions the Webhook
          // resource (FQN-deduped, §Q6.1) and binds the secret; at
          // runtime it registers the verified-delivery listener.
          yield* consume(
            { ...repo, events: [event] },
            (delivery) =>
              routeDelivery(hubs, delivery).pipe(
                // GitHub's delivery id keys the admission ledger, so
                // webhook redeliveries collapse idempotently.
                Effect.andThen(admitToSubscribedRings(rings, delivery)),
              ),
          );
        }

        const hub = yield* getOrCreateHub(hubs, source["~alchemy/Name"]);
        return Stream.fromPubSub(hub).pipe(
          // decode through the source's schema at the boundary
          Stream.mapEffect((raw) => S.decodeUnknownEffect(source.schema)(raw)),
        );
      }),
    });
  }),
);
```

And the source constructors stay in `github-events.ts`, now carrying props
(the family constructors pin the bare GitHub event name so the Layer knows
what to provision — mirroring how `RepositoryEventSourceProps.events` is
declared, `src/GitHub/RepositoryEventSource.ts:66-70`):

```ts
// src/org/github-events.ts (redesigned)
export interface GitHubSourceProps {
  repo: RepositoryRef;
  /** bare GitHub event name — what the webhook is provisioned with */
  event: GitHub.GitHubEventName;
  /** family-specific runtime filter (label, branch, …) */
  filter?: Record<string, string>;
}

export const IssueOpened = (repo: RepositoryRef) =>
  AI.EventSource(`github.issues.opened/${key(repo)}`, IssueOpenedEvent, GitHubEvents, {
    repo,
    event: "issues",
  } satisfies GitHubSourceProps);

export const IssueLabeled = (repo: RepositoryRef, label: string) =>
  AI.EventSource(`github.issues.labeled/${key(repo)}#${label}`, IssueLabeledEvent, GitHubEvents, {
    repo,
    event: "issues",
    filter: { label },
  } satisfies GitHubSourceProps);
```

### 3.7 Solving the dedupe

- **Across sources in one Worker**: two levels. (1) The Live layer's `wired`
  set collapses subscriptions per `(repo, event)` before calling
  `consumeRepositoryEvents` — layer-local, cheap, and it means each delivery
  path is claimed exactly **once** (avoiding the multi-listener
  `discard: true` fetch edge, §Q6.3). (2) The `Webhook` resource FQN dedupe
  (`src/Resource.ts:239-243`) is the engine-level backstop.
- **Union-of-events per repo**: today's `Webhook` id is per-repo, so differing
  `events` props from different subscribe calls would silently take
  first-wins (§Q6.1). Recommendation: provision **one Webhook per (repo,
  bare-event-name)** — id `` `${owner}/${repo}/${event}` `` — GitHub allows
  multiple hooks per repo, each hook's props are then constant, and FQN dedupe
  is exact rather than lossy. (Alternative if hook count matters: one hook per
  repo with `events: ["*"]` and runtime filtering; or adopt the
  Cron/S3-notifications pattern — one *binding* per subscription unioned by a
  provider — but that requires promoting the webhook to a
  binding-contract-bearing resource, which is more machinery than this needs.)
- **Across deliveries**: idempotency stays where the fixture already puts it —
  the ring DO's admission ledger keyed by GitHub's delivery id
  (`test/AI/fixtures/org/cloudflare/kernel.ts:42-57`,
  `events.ts:43-51`).

### 3.8 What to delete from the current draft

1. **`wire` field and `WireReq` type parameter** on `EventSource` —
   `src/AI/EventSource.ts:52-75` (the field at `:70-74`, the phantom at
   `:57-58`, the 4-arg constructor overload at `:87-94`, the `wire` pass-through
   at `:99-107`). Replace with the `props` field (§3.2).
2. **`WireReq` flowing through triggers** — the
   `| Sources[number]["~alchemy/WireReq"]` member of `on`'s Channels union
   (`src/AI/Trigger.ts:55`) and the `EventSource<any, any, any>` 3-arity
   references (`Trigger.ts:47,51-56`). `RefServices` (`src/AI/Services.ts:50-51`)
   needs no change.
3. **The hardcoded repos loop** in the Cloudflare channel layer —
   `test/AI/fixtures/org/cloudflare/events.ts:35-53` (the
   `for (const repo of repositories)` block and the `repositories` import at
   `:24`). Provisioning must be driven by the union of *subscribed* sources
   (via `subscribe`, §3.6), not by a side list — otherwise "declaring the
   subscription is what provisions the wire" is false: today a loop
   subscribing to a repo outside `repos.ts` would type-check and silently
   never fire.
4. **The doc comments claiming the kernel evaluates `wire`** —
   `src/AI/EventSource.ts:36-46,62-69` and the corresponding prose in
   `designs/ai/alchemy-ai-design.md` §1.2.3 (`:209-215` shows the 2-param
   shape, which is what we return to; the §1.2.3 narrative at `:228-233` is
   already correct and needs no change — it describes exactly the binding
   idiom).

### 3.9 What stays

- The channel-tag-in-`Req` mechanism (`Trigger` → `RefServices` → `AI.layer`)
  — it is precisely the binding idiom's "interpolating bubbles a Layer
  requirement" and already works.
- `EventChannelService.subscribe` returning `Effect<Stream<In>>`.
- The `GitHubEvents`/`DiscordEvents` family tags in the org fixtures.
- `GitHub.RepositoryEventSource` + `GitHubRepositoryEventSourceLive` as the
  infrastructure substrate the AI channel layer composes over — no new
  webhook machinery is needed; the AI layer is routing + schema decode +
  ring admission on top of an existing, already-idiomatic event-source
  binding.
