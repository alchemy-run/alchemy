# CLI Overhaul Cleanup Plan

This file is the durable handoff for review feedback against the changes after
`b62e66041ffc0079c544415a068624d7b70f9ee4`. No production code has been changed
as part of this review pass.

## Working rules

- Keep one service contract and one implementation per control module.
- A module owns its routes. The root control surface only composes top-level
  modules; it does not repeat every leaf operation.
- Inject dependencies through Effect services/layers. Do not add `with*`,
  `normalize`, or `provide` pass-through helpers.
- Prefer Effect's tagged-error, predicate, duration, random, brand/schema, and
  context/layer APIs over hand-rolled equivalents and assertions.
- Preserve behavior unless a task below explicitly calls for a behavior change.
- Add or adjust focused tests before collapsing/replacing an existing behavior.

## Review verdicts

### 1. [x] `AlchemyControl/AlchemyControl.ts:68-72` — aggregate aliases

**Verdict: Confirmed. Introduced by this PR.** `StateControlError` and
`AlchemyControlEvent` exist only to restate unions/events owned by the state
module. They are symptoms of the root facade duplicating module contracts.

**Task:** Remove these aliases when the root service is reduced to top-level
module services. Let `StateControl` expose its own error and event types.

### 2. [x] `AlchemyControl/AlchemyControl.ts:78-230` — root repeats every route

**Verdict: Confirmed. Introduced by this PR.** Although individual control
services now exist, `AlchemyControlService` redeclares every leaf (`plan`,
`deploy`, state operations, provider operations, etc.). That leaves two sources
of truth and does not satisfy module-owned routing.

**Task:** Redesign `AlchemyControl` as a composition of top-level modules only.
Use module service types directly, with a shape along the lines of `stack`,
`drift`, `logs`, `state`, `profile`, `provider`, `unsafe`, and `operation`.
`StackControl` owns `plan/deploy/destroy/dev`; provider modules own their nested
routes. Update consumers to select the owning module rather than a duplicated
leaf on the facade.

### 3. [x] `AlchemyControl/AuthProviders.ts:20` — inline type import

**Verdict: Confirmed. Introduced by this PR.** The field uses
`import("effect/Option").Option<string>` even though this is an ordinary static
type dependency.

**Task:** Add a normal `import type * as Option from "effect/Option"` and use
`Option.Option<string>`.

### 4. [x] `AlchemyControl/AwsControl.ts:59-60` — `normalize` helper

**Verdict: Confirmed. Introduced by this PR.** The helper is a one-line wrapper
around `Effect.provide(context)` and `internalize`, used only twice.

**Task:** Inline the pipeline at `bootstrap` and `teardown`. Apply the same rule
to the identical helpers in `CloudflareControl`, `DriftControl`, and
`LogControl`.

### 5. [x] `AlchemyControl/CloudflareControl.ts:63-64` — `normalize` helper

**Verdict: Confirmed. Introduced by this PR.** Same pass-through pattern as AWS.
The nearby nested generator also contains `yield* yield*` for
`CloudflareEnvironment`, which makes the flow harder to read.

**Task:** Inline provisioning/internalization and flatten the nested generator;
bind the environment service once with a normal `yield*`.

### 6. [x] `AlchemyControl/CloudflareTokenControl.ts:81-96` — `withCredentials`

**Verdict: Confirmed. Introduced by this PR.** The helper manually wraps each
operation with a credential service and captured ambient context. It is a
service-locator/passthrough pattern rather than dependency injection.

**Task:** Model the selected Cloudflare credentials as an Effect service/layer
provided at the operation boundary, or make a credential-scoped token-control
implementation. Operations should declare requirements through their Effect
types and be provided by composition, not a `withCredentials` callback.

### 7. [x] `AlchemyControl/CloudflareTokenControl.ts:103-109` — inline service yields

**Verdict: Confirmed. Introduced by this PR.** `Effect.all` is given calls built
with inline `(yield* service)(...)` expressions, mixing dependency acquisition
with object construction.

**Task:** Yield `accounts.listAccounts` and
`user.listTokenPermissionGroups` into named bindings first, then use the object
form of `Effect.all` so the response fields are named and destructuring is
unnecessary.

### 8. [x] `AlchemyControl/ControlEffect.ts:27-33` — `instanceof` tagged errors

**Verdict: Confirmed. Introduced by this PR.** All seven control errors are
`Data.TaggedError` values, but `internalize` identifies them by constructor
identity. That is fragile across realms/package duplication.

**Task:** Use `Predicate.isTagged` (or the appropriate tagged-error matcher in
the pinned Effect version) against the allowed `_tag` union. Add tests proving
plain tagged values and errors from another module instance are preserved.

### 9. [x] `AlchemyControl/DriftControl.ts:92-96` — asserted IDs and global random

**Verdict: Confirmed. Introduced by this PR.** IDs are structural intersections
in `Surface.ts`, generated with global `crypto.randomUUID()` and forced through
`as` assertions. The same pattern exists in `Operations`, `StackLifecycle`, and
`NukeControl`.

**Task:** Define Effect-branded ID types and exported constructors/generators.
Generate entropy through Effect's `Random` service so tests can inject it. Use
the constructors for `OperationId`, `PlanId`, `PlanRevision`, `DriftId`,
`NukeScanId`, and `NukeResourceId`; remove every UUID brand assertion.

### 10. [x] `AlchemyControl/Live.ts:51-61` — sequential service acquisition

**Verdict: Confirmed. Introduced by this PR.** Eleven independent services are
yielded sequentially.

**Task:** Acquire them with the object form of `Effect.all`, preserving named
fields. Re-evaluate whether this facade remains necessary after task 2.

### 11. [x] `AlchemyControl/Live.ts:62` — `provide` helper

**Verdict: Confirmed. Introduced by this PR.** It is another single-purpose
pass-through wrapper around `Effect.provide(context)`.

**Task:** Remove it. Prefer layer composition; inline provision only where a
boundary genuinely must erase requirements.

### 12. [x] `AlchemyControl/LogControl.ts:87` — `normalize` helper

**Verdict: Confirmed. Introduced by this PR.** Same helper family as findings 4
and 5.

**Task:** Inline it and ensure each public operation has an explicit Effect
requirement rather than closing over a broad ambient context unnecessarily.

### 13. [x] `AlchemyControl/NukeControl.ts:46-57` — hand-rolled predicates

**Verdict: Confirmed. Introduced by this PR.** `isCollection` and
`hasListAndDelete` perform manual object/null/property checks and assertions.
Effect already exposes `Predicate.isObject`, `Predicate.hasProperty`,
`Predicate.isFunction`, and `Predicate.isTagged`.

**Task:** Replace these guards with Effect predicates. Prefer a tagged provider
collection contract where possible, and do not introduce replacement
single-use guard helpers.

### 14. [x] `AlchemyControl/NukeControl.ts:168-181` — structural failure object

**Verdict: Confirmed. Introduced by this PR.** `failure` manually constructs a
`ProviderFailure` object with `_tag: "ProviderFailure"`; `ProviderFailure` is
only an interface, unlike the other control errors.

**Task:** Make `ProviderFailure` a `Data.TaggedError` with a precise cause/error
payload, construct it with `new ProviderFailure(...)`, and keep the error union
typed through nuke scan/execute paths. Avoid the vague nested `Unknown` error
shape where the underlying tag is known.

### 15. [x] `AlchemyControl/Operations.ts:53` — asserted operation ID

**Verdict: Confirmed. Introduced by this PR.** This is part of the UUID/assertion
family in finding 9.

**Task:** Use the shared Effect-branded `OperationId` generator; do not retain a
file-local one-line helper.

### 16. [x] `AlchemyControl/StackLifecycle.ts:51` — alias helper

**Verdict: Confirmed. Introduced by this PR.** `normalizeFailure` is a direct
alias of `internalize` and adds no domain meaning.

**Task:** Call `internalize` directly, then reassess whether broad
internalization belongs at each module boundary or once in routing.

### 17. [x] `AlchemyControl/StackLifecycle.ts:53-54` — ID helpers

**Verdict: Confirmed. Introduced by this PR.** Both are assertion-based,
single-line UUID wrappers.

**Task:** Replace with the shared branded generators from finding 9.

### 18. [x] `AlchemyControl/StackLifecycle.ts:56-63` — duplicated summary

**Verdict: Confirmed. Introduced by this PR.** The same `summaryOf` function is
present in `DriftControl.ts:49-56`.

**Task:** Move plan summarization to the plan/domain module (or a shared
unexported control helper if no domain home exists), type the accumulator as
`PlanSummary`, and use it from both modules.

### 19. [x] `AlchemyControl/StackLifecycle.ts:94-101` — repeated `Layer.succeed`

**Verdict: Confirmed. Introduced by this PR.** Three value services are built as
separate `Layer.succeed` calls inside a larger `Layer.mergeAll`.

**Task:** Batch value services into one Context and expose one context layer,
using the pinned Effect APIs. Apply the same cleanup to adjacent groups in
`DriftControl`, `StackSession`, and `StateSession`; do not mechanically merge
layers whose dependencies/lifecycles differ.

### 20. [x] `AlchemyControl/StateControl.ts:22-38` — `withState`

**Verdict: Confirmed. Introduced by this PR.** Every operation is routed through
a callback helper that resolves a state service and then invokes a leaf.

**Task:** Make state-source resolution an injected service/layer or construct a
source-scoped `StateControl` implementation. Let state operations depend on the
resolved state service directly; retain the explicit missing-source error at
the resolution boundary.

### 21. [x] `AlchemyControl/StateSession.ts:51-57` — nested generator

**Verdict: Confirmed. Introduced by this PR.** A generator exists only to
perform `return yield* yield* State.State`, then receives three providers.

**Task:** Yield/bind the `State.State` service normally and provide the composed
layer in a single readable pipeline. Remove the nested generator and double
yield.

### 22. [x] `Apply.ts:315-324` — destroy invariant behavior

**Verdict: Not a bug; pre-existing behavior.** The same `deleteStack`, follow-up
`state.list`, and `StateStoreError` invariant existed before `b62e660`; this PR
only moved it while restructuring apply progress. It is tied to issue #961 and
guards against reporting a destroy as successful while persisted resources
remain.

**Task:** No behavior change. Preserve this block during cleanup. A separate
proposal would be required to remove or alter the invariant.

### 23. [x] `Cli/GlobalLog.ts:13` — arithmetic milliseconds

**Verdict: Confirmed. Introduced by this PR.** Seven days is encoded as manual
millisecond arithmetic despite `effect/Duration` being used elsewhere.

**Task:** Store the threshold as `Duration.days(7)` and convert with
`Duration.toMillis` only at the filesystem timestamp comparison boundary.

### 24. [x] `Cli/commands/_shared.ts:345-356` — manual duration parsing/math

**Verdict: Confirmed. Introduced in the rewritten command layer.** The parser
manually maps `s/m/h/d` to millisecond multipliers.

**Task:** Parse the matched amount/unit into `Duration.seconds/minutes/hours/days`
and subtract `Duration.toMillis(duration)` from `Clock.currentTimeMillis`.
Preserve the current accepted CLI grammar and error text with focused tests.

### 25. [x] `Cli/commands/cloudflare.ts:285-313` — fragmented output

**Verdict: Confirmed. Introduced by this PR.** One result is emitted through six
separate `Console.log` calls plus a diagnostic loop, making output ordering and
testing unnecessarily fragmented.

**Task:** Add a pure formatter that returns the complete success message
(including blank lines and diagnostics as appropriate), then issue one logging
operation for the full string. Keep secret handling explicit: unwrap the token
only at the output boundary and do not include it in debug logs.

### 26. [x] Control operations — typed scoped streams

**Task:** Replace the background operation registry, snapshots, replay buffer,
and `unknown` event envelopes with a scoped `Operation` stream. Stream
interruption owns cancellation, expected failures use the error channel, and a
typed `Succeeded` variant carries the result.

### 27. [x] Module-owned operation events

**Task:** Keep Schema tagged-union definitions with stack, drift, profile, and
nuke rather than splitting contracts into extra files. Add shared helpers only
for the universal terminal variant and stream consumption.

### 28. [x] CLI/TUI operation glue

**Task:** Consume module event streams directly in deploy, drift, profile, and
nuke routes. Remove operation IDs, snapshot polling, status branching, unknown
payload casts, and planning report callbacks from presentation code. Keep the
stage beside every planning message.

### 26. [x] `Cli/commands/profile/hub.ts:9-15` — vague unknown errors

**Verdict: Confirmed. Introduced by this PR.** `messageOf(unknown)` accepts any
shape with a string `message` and collapses it to display text. This discards
the tagged error model used by the control layer.

**Task:** Give profile dashboard actions explicit tagged error channels and
handle them with `catchTag`/`matchCause` at the UI boundary. Remove `messageOf`.
Audit the dashboard callback contracts so they do not require `unknown` errors.

### 27. [x] `Local/DevLog.ts:26-27` — arithmetic retention duration

**Verdict: Confirmed. Introduced by this PR.** Same duration issue as global
logs.

**Task:** Use `Duration.days(7)` and convert at the mtime comparison. Keep the
generation count as a number because it is not a duration.

### 28. [x] `Local/RpcSpawner.ts:199-209` — heartbeat behavior

**Verdict: Intended, but newly introduced.** The heartbeat was added in this PR.
It immediately flushes streaming response headers and sends a frame every five
seconds to prevent Bun's roughly ten-second idle timeout. The client ignores
frames without `line`, so it is transport liveness rather than user-visible
logging behavior.

**Task:** Keep the heartbeat unless a test demonstrates the transport no longer
needs it. Replace the string duration with `Duration.seconds(5)`, give the
heartbeat wire shape a typed/schema-validated representation, and add a focused
test for immediate first emission, periodic liveness, and client-side ignore.

## Reported behavioral regressions

### 29. [x] Profile dashboard omits configured provider details

**Verdict: Confirmed presentation/data-contract bug; local state is valid.** The
manifest at `~/.alchemy/profiles.json` is schema version 2 and contains both
`default` and `test`. The selected default profile has Cloudflare `oauth`
configuration with account/scopes metadata and GitHub `gh-cli` configuration;
the corresponding default Cloudflare credential file also exists. No secret
values were inspected. `ProfileControl.get` currently maps stored providers to
only `name`, `method`, `status`, and an optional diagnostic. The dashboard hub
then maps exactly those fields into `ProfileProviderDisplay`, so its `lines`
array is empty for a healthy provider and the UI can only render “configured.”

**Task:** Restore provider detail projection in the module-owned profile
contract. Resolve/decode each configured provider using the registered auth
provider and its observational presentation API, returning typed, redacted
display rows (account, identity, expiry/scopes where the provider exposes
them). Do not read provider-specific fields in the React view and never expose
raw credentials. Make `profile show` and the dashboard consume the same
snapshot. Add tests using a valid manifest/config plus credential fixtures to
prove details render and secrets do not.

### 30. [x] A no-change deploy hides the plan's no-op resources

**Verdict: Confirmed TUI bug; the plan still contains the resources.**
`buildProgressRows` builds rows for no-op resources, but `PlanProgress` excludes
every `row.action === "noop"` from `taskRows` and returns only “No changes” when
that filtered array is empty. The non-interactive `formatPlanLines` path already
iterates `allItems`, and its test explicitly expects unchanged resources, so
the omission is isolated to the interactive progress view.

**Task:** Treat “no mutations” as a summary state, not an empty plan. Render the
full namespace/resource tree with all no-op rows (and their persisted statuses)
under the “No changes” result. Keep no-ops excluded from work/progress counts,
but never exclude them from the final plan display. Add an all-noop TUI snapshot
test and mixed-plan coverage proving unchanged siblings remain visible.

### 31. [x] Planning progress stalls visually at “Importing stack module”

**Verdict: Confirmed progress-reporting regression.** `deploy.ts` opens one
planning session with “Importing stack module,” invokes the entire
`StackControl.plan`, and only changes the message when that Effect completes
with “Plan ready.” Inside `StackLifecycle.makePlan`, stack import/evaluation,
service construction, state resolution, and `Sync.plan` all run without
progress updates. The long-running work is happening; its phases are simply no
longer observable.

**Task:** Make planning phases part of the module-owned stack route rather than
guessing in the command. Emit typed planning events (at minimum: importing
module, resolving stack/services, loading/resolving state, computing plan, plan
ready) through the operation/event service or an injected planning reporter.
Have both Ink and logging CLI adapters render the same events. Ensure phase
updates replace the active line, survive failure/interruption, and are tested
with controllable deferred phases so intermediate states cannot regress.

### 32. [x] Resource rows omit the fully qualified resource type

**Verdict: Confirmed TUI rendering omission.** Namespace flattening already
copies `resource.resource.Type` into `FlattenedItem.resourceType`, and the static
plan view renders it. `buildProgressRows` drops `resourceType` from its resource
row contract, and `PlanProgress` therefore renders only the logical ID. This is
why rows lack suffixes such as `(Fleet.Claude.Toolchain)` shown in the expected
output.

**Task:** Carry `resourceType` through `ProgressRow` and render it as a muted
parenthesized suffix on every resource row, including no-ops. Keep action/task
rows distinct. Add nested namespace coverage that expects exact labels such as
`toolchain (Fleet.Claude.Toolchain)` and verifies the type survives both active
and completed rendering.

### 33. [x] `ProfileGetInput.includeProviderStatus` is ignored

**Verdict: Confirmed contract bug.** `Surface.ts` declares
`ProfileGetInput.includeProviderStatus?: boolean`, and both profile UI flows
request `true`, but `ProfileControl` destructures only `{ name }` and its
internal `get(name)` always returns the same hard-coded `connected` status.
The contract promises optional observational status resolution that the
implementation never performs. This is also the direct reason the dashboard
cannot distinguish healthy credentials from reauthentication/invalid states.

**Task:** Make the module contract honest while implementing finding 29. Either
remove the flag and always return fully resolved provider status/details, or
honor it by decoding configured providers and invoking their observational
status/presentation APIs only when requested. Prefer one predictable snapshot
shape if the cost is acceptable. Add tests for connected, needs-reauth, invalid,
unavailable/unregistered, and status-disabled behavior; never trigger login or
mutation during observation.

### 34. [x] `Local/RpcSpawner.ts:237` trusts unvalidated HTTP JSON

**Verdict: Confirmed boundary-validation bug; introduced by this work.** The
server casts `request.json` through `unknown` to `RpcSpawnPayload` and
immediately reads `serverEntryUrl`. This is an external process/HTTP boundary,
so TypeScript cannot establish the payload shape and malformed input becomes a
defect or an unsafe spawn argument.

**Task:** Define an Effect Schema for `RpcSpawnPayload`, decode the request at
the server boundary, and return a typed 4xx response for malformed JSON or an
invalid/missing URL. Validate the accepted URL/protocol before
`fileURLToPath`. Add tests for missing fields, wrong types, invalid URLs, and a
valid TypeScript entrypoint.

### 35. [x] Control timestamps bypass Effect `Clock`

**Verdict: Confirmed Effect/testability pattern; introduced by this PR.**
`Operations.ts` creates event/start/completion timestamps with `new Date()`;
`StackLifecycle` and `DriftControl` do the same for plan snapshots. These values
are observable domain data, but tests cannot control them through Effect's test
clock. This is the time equivalent of the global UUID issue in finding 9.

**Task:** Generate observable timestamps from `Clock.currentTimeMillis` and
construct `Date` values at the typed boundary. Centralize snapshot/event time
creation only if it has domain meaning—do not add a pass-through helper. Add
deterministic tests with `TestClock` for operation ordering and plan creation
times.

## Cross-cutting pattern inventory

These are direct matches for the reviewed patterns, not an independent general
review.

- **Pass-through normalization/provision helpers:** `AwsControl.ts:59`,
  `CloudflareControl.ts:63`, `DriftControl.ts:62`, `LogControl.ts:87`,
  `Live.ts:62`, and the direct alias in `StackLifecycle.ts:51`.
- **Callback-style `with*` wrappers:** `CloudflareTokenControl.ts:81` and
  `StateControl.ts:22`. `LocalProvider`/`RpcProvider` matches have different
  locking/defaulting semantics and are out of scope for this cleanup unless a
  later review validates them separately.
- **Assertion-based branded UUIDs:** `Operations.ts:53`,
  `StackLifecycle.ts:53-54`, `DriftControl.ts:92,95-96`, and
  `NukeControl.ts:240,250`.
- **Duplicate plan summarization:** `DriftControl.ts:49-56` and
  `StackLifecycle.ts:56-63`.
- **Repeated value layers:** groups in `DriftControl.ts`,
  `StackLifecycle.ts`, `StackSession.ts`, and `StateSession.ts`.
- **Manual tagged/object inspection:** `ControlEffect.ts:27-33`,
  `NukeControl.ts:46-57`, and `profile/hub.ts:9-15`. Use
  `Predicate.isTagged`, `Predicate.isObject`, `Predicate.hasProperty`, and
  `Predicate.isFunction` as appropriate.
- **Manual duration literals in reviewed scope:** `GlobalLog.ts:13`,
  `_shared.ts:345-353`, and `DevLog.ts:26`. `RpcSpawner` already accepts a
  duration string but should use `Duration.seconds(5)` for consistency.
- **Dropped presentation data at adapters:** `ProfileControl.get` narrows stored
  provider data before `profile/hub.ts` builds display rows; `PlanProgress`
  drops `resourceType` even though `NamespaceTree` already carries it.
- **Filtering conflated with rendering:** `PlanProgress` uses mutation-only
  `taskRows` both for progress math and to decide whether the plan has rows.
  Keep work selection separate from final-plan visibility.
- **Opaque long-running module operations:** `StackLifecycle.makePlan` owns
  several observable phases, while `deploy.ts` can currently report only the
  outer start/end states.
- **Ignored declared options:** `ProfileGetInput.includeProviderStatus` is
  passed by callers but discarded by the service implementation.
- **Unvalidated external payloads:** `RpcSpawner` asserts the POST JSON shape
  instead of decoding it at the HTTP boundary.
- **Global time in observable control data:** `Operations`, `StackLifecycle`,
  and `DriftControl` use `new Date()` rather than Effect `Clock`.

## Execution order

- [x] **Phase 1 — contracts and routing:** Complete findings 1-2. Establish the
  final root/module ownership before changing implementations or consumers.
  Include the typed profile-detail and planning-event contracts required by
  findings 29 and 31.
- [x] **Phase 2 — injected dependencies:** Complete findings 4-7, 10-12, 16,
  19-21. Remove captured broad contexts and `with*`/pass-through helpers.
- [x] **Phase 3 — domain types and failures:** Complete findings 8-9, 13-15,
  17-18, 26, and 35. Add branded generators, tagged failures, and Effect-clock
  timestamps before updating call sites.
- [x] **Phase 4 — focused utility cleanup:** Complete findings 3, 23-25, and
  27-28 and 34. Preserve existing CLI grammar and transport behavior.
- [x] **Phase 5 — behavioral UI fixes:** Complete findings 29-32 after their
  module contracts exist, including finding 33's status semantics. Keep views
  as renderers of typed data/events rather than moving provider or planning
  logic into React components.
- [x] **Phase 6 — verification:** Run formatting, `vpx tsc -b`, and focused CLI,
  AlchemyControl, state, nuke, profile, logging, and RPC tests. Confirm
  `Apply.ts`'s destroy invariant is unchanged. Include all-noop plan, profile
  detail/redaction, planning phase, and resource-type rendering tests.
- [x] **Phase 7 — stack hygiene:** Keep fixes on `feat/cli-overhaul`, refresh
  `pnpm-lock.yaml` only on the top branch if dependencies change, then amend or
  squash so the PR remains one commit.

## Acceptance checklist

- [x] Root control contract contains top-level modules only and does not repeat
  leaf route signatures.
- [x] Each module declares and implements its own service and routes.
- [x] No reviewed `normalize`, `provide`, `withCredentials`, `withState`, or
  direct-alias helper remains.
- [x] No control ID is created with an `as` assertion or global
  `crypto.randomUUID()`.
- [x] Control failures are tagged and matched by tag, not `instanceof` or vague
  message extraction.
- [x] External RPC payloads are schema-decoded before use.
- [x] Observable operation/plan timestamps use Effect `Clock` and are
  deterministic under `TestClock`.
- [x] Repeated value services are composed in context layers where valid.
- [x] Reviewed durations use Effect `Duration` values.
- [x] Profile dashboard and `profile show` render the same redacted provider
  details from valid on-disk state.
- [x] An all-noop plan still renders its complete namespace/resource tree.
- [x] Planning visibly advances through import, resolution/state, and plan
  computation phases.
- [x] Every resource row includes its fully qualified resource type.
- [x] Destroy-state safety and RPC liveness behavior remain covered and intact.
- [x] Typecheck and focused tests pass with a clean worktree.
