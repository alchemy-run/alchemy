# The components of a software factory — service seams over environments

Status: **v1** (2026-07-16). Phase D of the software-factory-components
plan (`software_factory_components_26133547.plan.md`). This report is
research, not implementation: it proposes the component catalog; the
plan builds only `Ledger`/`TaskQueue` in the current arc. Where this
report and the canon ([business-processes.md](../business-processes.md)
v4.1) disagree, the canon wins.

The question answered: **what are the recurring service seams that
factory processes compose over** — each a plain Effect
`Context.Service` contract with proliferating per-environment Layers
(local | Cloudflare | AWS), exactly like `Ledger` and
`GitHub.RepositoryEventSource` — such that processes, agents, tools,
and skills compose into higher-level processes, recursively, up to an
org that maintains its own source?

Sources (all read; claims about existing code cite file paths, line
numbers where load-bearing):

- The approved plan (`software_factory_components_26133547.plan.md`) —
  the reframe, the Ledger/seam sections, "How the work gets done".
- [business-processes.md](../business-processes.md) (canon v4.1),
  [alchemy-ai-design.md](../alchemy-ai-design.md) §3 (harness seams)
  and §8–9 (the July 2026 loop-engineering + harness-archaeology
  surveys), [bp-dx-open-source-org.md](./bp-dx-open-source-org.md)
  (catalog + gap list).
- Code: `packages/alchemy/src/GitHub/RepositoryEventSource.ts`,
  `packages/alchemy/src/Cloudflare/Workers/GitHubRepositoryEventSource.ts`,
  `packages/alchemy/src/Cloudflare/Workers/CronEventSource.ts`,
  `packages/alchemy/src/AI/{Kernel,TraceStore,Ask,EventBus,EventSource,
  Observe,Budget}.ts`, `packages/alchemy/src/GitHub/{Events,FrontDoor}.ts`,
  `services/alchemy-org/src/*`, `packages/alchemy/src/AWS/Scheduler/`,
  `packages/alchemy/src/AWS/Lambda/Microvm*.ts`,
  `packages/alchemy/src/Cloudflare/Containers/`,
  `packages/alchemy/src/Docker/`, `packages/alchemy/src/SQLite/`.
- Web (July 2026): Warp Oz platform docs (orchestration layer,
  environments, integrations, auto-tracking), Devin v3 API surface
  (sessions, playbooks, knowledge, schedules, snapshots, session
  insights), Factory.ai Missions architecture (orchestrator / workers /
  validators, shared artifacts, signals doctrine), Temporal component
  architecture (frontend/history/matching/worker; tasks, timers,
  signals), Restate (virtual objects, awakeables, `ctx.run`, durable
  timers), Orleans (grains, pluggable providers for persistence /
  streams / reminders / clustering). Details in §1.

---

## 0. Verdict up front

**The component model is already in force — the catalog names it and
extends it.** `GitHub.RepositoryEventSource` (one tag; webhook Layer
shipped, polling Layer planned), `AI.Kernel` (memory | Cloudflare-DO),
`AI.TraceStore` (memory | DO-SQLite planned), `AI.AskHub` (memory |
durable planned), and the plan's `Ledger` (Memory | Sqlite | D1) are
all the same shape: a small `Context.Service` contract, physics chosen
entirely at composition. The factory thesis — *"the factory is one
Layer expression; the environment is the provide-list"* — is not a new
architecture; it is this shape applied consistently.

The catalog, with priorities (justifications inline in §3):

| # | Component | One-line responsibility | Status | Priority |
|---|---|---|---|---|
| 1 | **Ledger** (né TaskQueue) | transactional dedupe + liveness for admitted work: `offer`/`settle` idempotent by `(queue, key)` | being built (plan Phase B/C) | **P0** (in flight) |
| 2 | **EventSource family** (EventIngress, reframed) | world events → verified, typed deliveries; one tag *per provider family*, webhook/gateway + polling physics per tag | GitHub shipped (webhook); polling in plan; Discord/Slack/Stripe missing | **P0** (GitHub polling) / P1 (Discord, Slack) / P2 (Stripe) |
| 3 | **Workspace** | where code work happens: scoped checkout + exec + diff; the Engineer's and Judge's physics | stubs only (`services/alchemy-org/src/layers.ts`) | **P1** (local Layer effectively P0½ — the demo needs it) |
| 4 | **HumanGate = Ask/AskHub** | park durably until a correlated human answer arrives; surface-paired Layers | contract + memory hub shipped (`src/AI/Ask.ts`); durable/Slack/GitHub-review Layers missing | **P1** |
| 5 | **Scheduler** | recurring mandates as deliveries: `every(cron, handler)`, platform-agnostic tag | Cloudflare-scoped tag shipped (`CronEventSource`); portable tag missing | **P1** |
| 6 | **TraceStore** (Tracker, reframed) | the durable event log behind kernel `trace`; evals are *consumers*, not a component | contract + memory Layer shipped (`src/AI/TraceStore.ts`) | **P1** (durable Layers) |
| 7 | **ArtifactStore** | blobs that outlive a run and cross environments: case files, handoffs, fixtures | not started (name collides with deploy-engine `Artifacts.ts` — rename needed) | **P2** |
| 8 | **Notifier** | fire-and-forget outbound announcements to a surface; local = stdout | not started | **P2** |
| 9 | **ModelProvider** | the model as a Layer | already the industry norm and already ours (`worker.ts:85-99`) | note only |

Killed from the candidate list (full reasoning §5): **RunRegistry**
(a derived read model — the new `AI.Process<Self, Interface>` parameter
is exactly where "what's live" queries belong), **Evals/Tracker as a
component** (processes over `kernel.trace` + `AI.observe`; the trace
store is the seam, the eval is app code), and — added to the kill list
from the external survey — **Orchestrator/Coordinator** (Factory's
three-role architecture is charters + Layers, not a service),
**KnowledgeStore** (skills are terms; their content is artifacts),
**SecretStore** (already alchemy resources + bindings), **generic
EventIngress super-interface** (per-family tags or nothing — §3.2).

Divergences from the prompt's candidate list, summarized:
EventIngress is reframed from "one generalized service" to "one
*pattern*, one tag per provider family" (type-erasure argument, §3.2);
RunRegistry and Tracker/Evals are killed as components and re-homed
(Interface methods; trace consumers); Notifier survives but barely
(the narrow deterministic-announcement case); nothing else was added
that the candidate list missed — the external survey kept mapping onto
the same nine seams, which is itself evidence the list is close to
complete (§4).

---

## 1. Method + sources

**Internal.** Read the plan end to end; the canon; §3 and §8–9 of the
master design; the OSS-org report's catalog and gap list; then the code
that already embodies the pattern — `RepositoryEventSource` (tag +
webhook physics + the deterministic `webhookPath`/`webhookSecretEnvName`
shared by both sides), `CronEventSource` (the same one-call-two-halves
shape for cron), `TraceStore`, `Ask`/`AskHub`, `Kernel`, `EventBus`,
`Observe`, and the current `services/alchemy-org` (which still uses the
derived front door the plan deletes — its `layers.ts` tool stubs are
the Workspace component's demand signal). Also surveyed what
per-environment physics already exist to become Layers: Cloudflare
Containers, D1, R2, KV, Queues, Workflows; AWS S3, SQS, DynamoDB,
EventBridge Scheduler, Lambda Microvms; Docker; `src/SQLite`.

**External.** Web research (July 2026), cross-referenced rather than
echoed:

- **Warp Oz** — platform decomposition: triggers/integrations (first-
  party = they own the webhook; custom = you own ingestion and call the
  API), an orchestration layer that is "the system of record for what's
  running and what ran", Environments (execution context), hosting,
  auto-tracking (every run leaves artifacts + transcript), skills.
- **Devin (Cognition)** — Brain (stateless cloud service) + Devbox
  (isolated execution VM); the v3 API's resource list *is* a component
  catalog: sessions, knowledge, playbooks, secrets, schedules,
  attachments, audit logs, snapshots, session insights.
- **Factory.ai** — the software-factory framing verbatim ("signals from
  outside the codebase … the entire system is a continuous feedback
  loop"); Missions' orchestrator/workers/validators with **shared
  state as artifacts** (validation contract, feature list, research
  notes, knowledge base — not a database, files); sandboxed cloud dev
  environments; Git as the source of truth.
- **Temporal** — the four-service decomposition (frontend / history /
  matching / worker); tasks + task queues as the matching seam; timers,
  signals, schedules as first-class; event history as the one log.
- **Restate** — durable functions + virtual objects (keyed state,
  single-writer per key), awakeables (external resolution = our Ask),
  durable timers, `ctx.run` journaling; "queues are often used to
  provide retries, scheduling, and async hand-off, all of which a
  durable execution engine offers natively."
- **Orleans** — the purest prior art for the *shape* of our claim:
  grains (virtual actors) + **pluggable providers** for persistence,
  clustering, streams, and reminders — "swap storage, clustering,
  streaming, reminders … without changing application code." Orleans
  reminders vs timers (durable vs in-memory scheduling) is precisely
  our Scheduler-Layer split.
- **CI/CD as factory analog** — reasoned from GitHub Actions'
  primitives rather than searched: workflow (process), runner
  (workspace), triggers (`on:` = event ingress), schedule (cron),
  artifacts + cache (artifact store), environments with required
  reviewers (human gate), the checks API (notifier + tracker). A CI
  system is a degenerate software factory whose processes are all
  deterministic; every component below has a CI counterpart, which is a
  useful completeness check (§4).

**Criteria for "component".** A candidate earns a `Context.Service`
contract only if all three hold:

1. **≥ 2 genuinely different physics exist or are demanded** (not two
   wrappers over the same API). Webhook vs polling; console vs Slack;
   local clone vs container.
2. **≥ 2 distinct factory processes consume it** through the same
   contract (issue flywheel, release train, support desk, autoresearch).
   A seam with one consumer is app code wearing a costume.
3. **The contract is smaller than the union of its implementations** —
   the tag must not leak one environment's vocabulary (no
   `ScheduledController` in a portable Scheduler; no Octokit types
   outside the GitHub family tag).

The plan's extraction doctrine governs the build side: contracts are
**extracted from evidence, not designed up front** — this report
proposes shapes; each is validated only when its two call sites exist.

---

## 2. The component model — what `Ledger` and `RepositoryEventSource` prove

The two exemplars establish the invariants every catalog entry below
follows:

- **One tag, many physics.** `RepositoryEventSource` is a single
  `Context.Service` (`src/GitHub/RepositoryEventSource.ts:167-170`);
  `Cloudflare.Workers.GitHubRepositoryEventSourceLive` implements it by
  provisioning a repository `Webhook` resource at deploy time and
  claiming the delivery path + verifying HMAC at runtime
  (`src/Cloudflare/Workers/GitHubRepositoryEventSource.ts:34-50`); the
  planned `RepositoryEventSourcePolling` implements the *same tag* with
  Octokit + cursors + a bounded `Schedule`, synthesizing
  webhook-shaped deliveries with deterministic ids. The consumer
  (`consumeRepositoryEvents`) cannot tell which physics served it.
- **The implementation owns its infrastructure.** The webhook Layer
  declares the `Webhook` resource; the plan's `D1Ledger` declares its
  own `Cloudflare.D1.Database("org-ledger")`. A process implementation
  Layer never sees the wire or the table — this is the bindings pattern
  (`Binding.Service` with `*Binding` vs `*Http` physics,
  `src/Binding.ts`) applied above the resource level.
- **Deterministic identity makes physics interchangeable.** Ledger
  dedupe works across webhook redeliveries *and* poll re-observations
  only because delivery ids are deterministic
  (`poll/{repo}/{event}/{id}/{updated_at}`); the same discipline
  already governs Trace events (`Kernel.ts:32-52`: ids derived from
  `(term, session, turn, ordinal)`, never minted at emit).
- **Environment is the provide-list, and only the provide-list.** The
  plan's table (local: polling + Sqlite + `AI.memory`; Cloudflare:
  webhook + D1 + DO-routing kernel) is the whole doctrine; each row of
  that table is one component of this catalog.

Orleans is the external proof this shape scales: a 15-year-old
production actor framework whose entire extension story is "pluggable
providers" behind stable grain-facing contracts — persistence,
reminders, streams, clustering — swapped without touching application
code. Our version is stronger in one respect (the contract is a typed
Effect service, and a missing Layer is a compile error in `Req`, not a
runtime DI failure) and deliberately weaker in another (we proliferate
Layers per cloud in-tree rather than defining a provider SPI — the
Layer *is* the SPI).

---

## 3. The catalog

Each entry: responsibility → contract sketch (minimal; extraction
doctrine applies) → per-environment Layers → what it wraps → which
processes need it → priority with justification.

### 3.1 `Ledger` — transactional dedupe + liveness (exists in plan; promotion shape assessed)

**Responsibility.** Decide, transactionally, whether an admitted piece
of work is new (`send`) or already-known (`steer`), however many
concurrent instances run the deciding code and however many times the
world re-delivers. It is the coordination plane of the factory: the
thing that makes a stateless Worker fleet and a laptop process run
identical code. It is deliberately NOT execution physics — per-key
serialization belongs to the kernel Layer (Durable Objects on
Cloudflare); the ledger and kernel never reach into each other (plan
Phase C division of labor).

**Contract (as planned; assessed below).**

```ts
export class Ledger extends Context.Service<Ledger, {
  /** Transactionally idempotent by (queue, key): redelivery ⇒ accepted: false. */
  offer(queue: string, key: string, task: unknown): Effect.Effect<{ accepted: boolean }>;
  settle(queue: string, key: string): Effect.Effect<void>;
}>()("alchemy-org/Ledger") {}
```

**Layers.** `MemoryLedger` (tests) · `SqliteLedger(path)` (laptop,
restart-resume; `src/SQLite/` provides the driver) · `D1Ledger` (the
D1 resource declared inside the Layer) · later `DynamoLedger`
(conditional put on `(queue, key)`) — AWS follows the same tag.

**Wraps / maps to.** The Cloudflare harness's `WorkQueue` seam
(`alchemy-ai-design.md` §3.2) and the Ring DO's coordination plane
("one ordered, idempotent inbox keyed by delivery id" — §3.1) are the
kernel-internal cousins; the org-level Ledger is the *pre-admission*
half. Externally: Temporal's matching service (task queues), Flue's
mutable submission ledger (CAS claims, attempt markers), Hatchet's
Postgres queue, Orleans stream cursors.

**Consumers.** Every event-driven process: issue flywheel, PR train,
support desk. Autoresearch consumes it indirectly (its weekly mandate
arrives via Scheduler but its dispatched experiments dedupe here).

**Promotion shape — assessment.** Three judgments:

1. **Name: keep `Ledger`, not `TaskQueue`.** The contract is a dedupe
   ledger, not a queue: there is no `claim`/lease, no visibility
   timeout, no ordering guarantee, no consumer-group semantics.
   `TaskQueue` invites exactly those expectations (Temporal task
   queues, SQS) and every one of them is deliberately absent — ordering
   and serialization are the kernel's job, retry is `Effect.retry` at
   the call site. Rename only if evidence forces `claim` in (see 3).
2. **`settle` needs a documented failure story before promotion.** The
   plan's contract returns `Effect<void>` with no error channel. What
   does `settle` of an unknown key do? (Recommend: idempotent no-op —
   delete-idempotency doctrine, same as resource `delete`.) What
   happens when a run settles but the world re-delivers a late event
   for the settled key? That is the canon's re-admission door
   (fold-seeded new run) and it needs the ledger to *report* "settled"
   distinctly from "unknown" — which suggests `offer` may need a
   three-valued answer (`accepted | duplicate | settled`) rather than
   a boolean. Extraction doctrine: let the re-admission test decide;
   flagging it now so it's tested deliberately.
3. **Do not add `claim`/lease speculatively.** The two proving call
   sites (issues, PRs) both run the handler inline with delivery. A
   lease becomes justified only when a physics exists where delivery
   and execution are decoupled *outside the kernel* (e.g. an SQS-fed
   fleet without a DO-style serializer). Note it; don't build it.

**Priority: P0** — in flight; the plan gates promotion on both physics
(sqlite kill-and-restart; D1 concurrent instances) working.

### 3.2 The `EventSource` family — EventIngress, reframed

**Responsibility.** Turn world events into verified, schema-typed
deliveries invoked against a handler, with the *consuming call site*
carrying the provisioning compile fence (the webhook/gateway is
provisioned because the code that consumes it says so — the "declaring
provisions the wire" territory §9.2 found genuinely unoccupied across
all eight surveyed harnesses).

**The reframe — kill the generic interface, keep the pattern.** The
prompt's candidate is "EventIngress: RepositoryEventSource generalized
beyond GitHub". The generalization must be the *convention*, not a
super-interface, for a type-erasure reason visible in the existing
code: the entire value of `RepositoryEventSource` is that
`consumeRepositoryEvents({ events: ["issues", "issue_comment"] }, …)`
narrows the handler's payload to Octokit's typed discriminated union
(`SelectedEvent`, `src/GitHub/RepositoryEventSource.ts:59-60`). A
provider-generic `EventIngress.subscribe(source: string)` returns
`unknown` and pushes decoding to every consumer — precisely the
anti-corruption work the typed tag already does once. Discord's
gateway events, Slack's Events API envelopes, and Stripe's event
objects each have their own complete typed unions; each deserves its
own tag with its own `events` selector. What *is* shared:

- the **one-call-two-halves shape** (plan-time provision guarded by
  `__ALCHEMY_RUNTIME__`, runtime verify-and-deliver) — already shared
  with `CronEventSource` and every `Binding.Service`;
- **deterministic delivery ids** so Ledger dedupe works across physics;
- the **deterministic path/secret conventions**
  (`webhookPath`/`webhookSecretEnvName`,
  `src/GitHub/RepositoryEventSource.ts:177-188`) — worth a small shared
  helper module when the second provider lands, not before.

One level up, `AI.EventChannelService`
(`src/AI/EventSource.ts:34-38`) already *is* the generic seam — one
channel tag per event family, consumed by the kernel for
machine-observed exits — so a generic ingress tag would also be
redundant with existing machinery.

**Contract sketch (per family — Discord shown; GitHub exists).**

```ts
// packages/alchemy/src/Discord/GuildEventSource.ts
export type GuildEventSourceService = <E extends readonly GatewayEventName[]>(
  props: { guildId: string; events?: E },
  process: (event: GatewayEvent<SelectedGatewayEvent<E>>) => Effect.Effect<void>,
) => Effect.Effect<void>;

export class GuildEventSource extends Context.Service<
  GuildEventSource, GuildEventSourceService
>()("Discord.GuildEventSource") {}
```

**Layers (per family).**

| Family | Local physics | Cloudflare physics | AWS physics |
|---|---|---|---|
| `GitHub.RepositoryEventSource` | `RepositoryEventSourcePolling` (plan: Octokit + `since`-cursors + bounded Schedule, deterministic ids, documented fidelity limits) | `GitHubRepositoryEventSourceLive` (shipped: Webhook resource + HMAC verify) | API Gateway/Lambda webhook Layer (later) |
| `Discord.GuildEventSource` | gateway WebSocket (the local physics is the *real* one — Discord's gateway needs a resident connection, which a laptop and a DO can hold but a stateless Worker cannot) | interactions-webhook Layer (slash commands / interactions only) + DO-hosted gateway for full events | — |
| `Slack.WorkspaceEventSource` | **Socket Mode** (Slack's own polling-equivalent: no public URL needed — the cleanest external validation that local-first physics of a webhook tag is a real vendor-supported pattern) | Events API webhook Layer | — |
| `Stripe.AccountEventSource` | `/v1/events` polling (Stripe's events API is genuinely pollable with cursors — same synthesis trick as GitHub) | webhook endpoint resource + signature verify | — |

**Wraps / maps to.** Warp Oz first-party integrations ("Warp manages
the event subscription and context extraction end to end") vs custom
("you own event ingestion and filtering") is exactly our
shipped-Layer vs hand-written-`consumeRepositoryEvents` split.
Factory.ai's signals doctrine ("signals from outside the codebase are
first-class inputs") is the responsibility statement. CI analog: the
`on:` block of a workflow.

**Consumers.** Issue flywheel + PR train (GitHub), support desk
(Discord/Slack), billing/refund processes (Stripe), any
`AI.exit(AI.when(...))` machine exit (via the channel Layer over this
tag — `src/GitHub/EventsLive.ts`).

**Priority.** GitHub polling **P0** (in plan; the local demo depends
on it). Discord **P1** (support desk is the second-oldest use case in
the design docs; `bp-dx-open-source-org.md` gap 9). Slack **P1** if the
org's humans live there (HumanGate's Slack Layer wants the same
plumbing — build together). Stripe **P2** (no charter needs it yet;
listed to prove the pattern generalizes beyond dev-tool providers).

### 3.3 `Workspace` — checkout + exec + diff

**Responsibility.** The place where code work physically happens: a
scoped, isolated checkout of a repository (or a prepared image) plus
the ability to execute commands in it, read what changed, and hand the
result somewhere durable (a branch push, a diff, an artifact). This is
the component the Engineer's `Bash`/`Grep`/`ReadFile`/`EditFile` tool
Layers close over, and the component whose *copy-on-write* variant is
the Judge's physics (verifier executes anything; effects don't escape
— `alchemy-ai-design.md` §3.2 Sandbox amendment, from the Academy
survey's "refusing `rm` by regex means the Judge can't run tests").

**The strongest external convergence in the whole survey.** Every
surveyed platform has exactly this component with a name: Devin's
**Devbox** (+ snapshots as prepared images), Warp Oz's
**Environments** ("what's the toolchain, what code does it have access
to") + hosting (Daytona/E2B/Docker sandboxes named as the primitive),
Factory's **sandboxed cloud dev environments** that "mirror the
project's toolchain", Cursor background agents' per-run VMs, CI's
runner + checkout action. Osmani's loop-anatomy lists "worktrees
(isolation)" as one of the five things a loop needs; Meta's
Brain2Qwerty ran three agents in isolated worktrees with no
cross-branch reads (§8.3).

**Contract sketch.** Two-level: acquire a handle (scoped — the Layer
decides what acquisition means), then operate through it. Keep the
operation surface to what the tool Layers demonstrably need:

```ts
export interface WorkspaceHandle {
  /** Absolute root of the checkout inside this workspace. */
  readonly root: string;
  exec(cmd: string, opts?: { cwd?: string; timeout?: Duration }):
    Effect.Effect<{ exitCode: number; stdout: string; stderr: string }, ExecError>;
  /** Porcelain diff of everything changed since acquisition (or `ref`). */
  diff(ref?: string): Effect.Effect<string>;
  /** Push current work to a branch — the durable hand-off. */
  push(branch: string): Effect.Effect<void, PushError>;
}

export class Workspace extends Context.Service<Workspace, {
  /** Scoped: release tears down the clone/container/microvm. */
  checkout(repo: RepositoryRef, ref?: string):
    Effect.Effect<WorkspaceHandle, CheckoutError, Scope.Scope>;
}>()("alchemy/Workspace") {}
```

Deliberate omissions: no `readFile`/`writeFile` (the tool Layers go
through `exec` or the handle's `root` + platform `FileSystem` — adding
typed fs methods is justified only if two Layers can't share the
`exec` path); no snapshot/restore (Devin-style prepared images are an
optional capability tag probed via `Effect.serviceOption`, per the
§3.2 sandbox doctrine — never a widened core interface); no
`overlay()` on the core contract (the Judge's COW workspace is a
*different Layer of the same tag* provided to the Judge's tools, which
is the capability-by-Layer discipline the two-`Bash` fixture already
demonstrates).

**Layers.**

| Layer | Physics |
|---|---|
| `LocalWorkspace` | `git clone`/worktree into a temp dir (`FileSystem.makeTempDirectory`), `exec` via child process; the plan's `localToolbox({ workspace: cloneOf(testAlchemy) })` is this Layer's first consumer |
| `DockerWorkspace` | container per checkout over `src/Docker/Container.ts` — local isolation without cloud |
| `CloudflareContainerWorkspace` (DevBox) | `src/Cloudflare/Containers/` — the plan's `devboxToolbox`; container image carries the alchemy-effect checkout with the distilled submodule embedded |
| `MicrovmWorkspace` (AWS) | `src/AWS/Lambda/Microvm*.ts` — Firecracker-style suspend/resume microvms; the suspend capability is the natural snapshot physics |
| Judge overlay | COW filesystem over any of the above — separate Layer, same tag |

**Wraps / maps to.** The harness's `Cloudflare.AI.Sandbox` seam
(§3.2) is the *kernel-internal* consumer of the same physics — the
right relationship is that the harness Sandbox Layer is *implemented
over* Workspace (or shares its container plumbing), not that they are
one tag: Sandbox's contract includes hibernation-watchdog and
activity-tracking obligations that are kernel lore, invisible to org
code.

**Consumers.** Engineer (read-write), Judge/Reviewer (COW overlay),
release train (build + changelog generation happen in a checkout),
autoresearch (Karpathy's `train.py`-only-writable discipline is a
Workspace Layer with a write-scope mount). Every factory process that
touches code — which is the point of a *software* factory.

**Priority: P1, with the local Layer effectively P0½.** The plan's
demo ("open an issue; the Engineer opens a PR") cannot run with
`layers.ts` stubs; `EngineerLocal` needs `LocalWorkspace` the moment
the flywheel goes live. But per the extraction doctrine the *contract*
should be factored out of `localToolbox` after it works, not designed
first — build the local physics inside the toolbox, then extract the
tag when `devboxToolbox` becomes the second call site.

### 3.4 `HumanGate` — the Ask protocol as a component (mostly exists)

**Responsibility.** Park a run durably until a correlated human answer
arrives; deliver the answer as verdict + optional policy amendment.
One protocol for approvals, structured questions, OAuth hand-offs, and
budget continuations (§9.3 — Eve's "one park protocol" lesson).

**Assessment: this component already has its contract and its first
Layer.** `Ask` (the requesting side, provided by the kernel to tool
executions) and `AskHub` (the answering side: `ask`/`pending`/`answer`)
are shipped `Context.Service`s with a memory hub
(`src/AI/Ask.ts:79-95, 139-142`). The component work remaining is
purely Layers:

| Layer | Physics |
|---|---|
| `AskHubMemory` | shipped — Deferred per parked ask |
| `AskHubConsole` | local: render pending asks on stdout, read verdicts from stdin — the laptop factory's approval surface |
| `AskHubDurable` (D1/DO) | ledger rows + webhook answers; ask ids are already deterministic (derived from the asking command) so replays collide idempotently — the docstring in `Ask.ts:28-31` already commits to this design |
| `AskHubSlack` / `AskHubDiscord` | post the ask to a channel with buttons; the interaction webhook delivers `answer(id, …)` — channel-paired with the surface whose EventSource triggered the run (§9.3 rule) |
| **GitHub-review-as-answer** | the flywheel's natural gate: the Reviewer's `Approve` tool doesn't need a parallel ask channel at all — an approved PR review *is* the answer, arriving over the world's own machinery (`PullRequestReviewSubmitted` via the GitHub EventSource), correlated by PR number. This is the canon's "answers arrive over world surfaces" made concrete, and it means the org's highest-stakes gate needs zero new infrastructure |

**Wraps / maps to.** Temporal signals / Restate awakeables ("for
external resolvers — approvals, webhooks — use an awakeable") are the
durable-execution names for the same seam. Codex's
approvals-as-policy-amendments is the `amendment` field. HumanLayer
(Horthy) is an entire company shipping only this component — strong
evidence it's a real seam. CI analog: GitHub environments' required
reviewers.

**Consumers.** Reviewer (merge authority), release sign-off, support
escalation, budget-continuation asks (`BudgetExceeded` with a
resume hint surfacing as a continuation Ask — §9.3).

**Priority: P1.** The autonomy dial is the org's central safety
property and today it only works in-memory. `AskHubConsole` is a
half-day; `AskHubDurable` rides the same D1 the Ledger brings; the
GitHub-review Layer should land with the PR-train process since it's
mostly event-source plumbing that 3.2 already provides.

### 3.5 `Scheduler` — recurring mandates

**Responsibility.** Deliver a mandate on a schedule — "every Monday,
consider cutting a release"; "weekly, study the traces" — as ordinary
front-door deliveries (platform cron → handler → `send`), never as
kernel auto-delivery.

**Why a portable tag is justified here (unlike EventIngress).** The
type-erasure argument from §3.2 cuts the other way for cron: the
payload is trivially portable (`{ expression, firedAt }`), so a
provider-generic tag erases nothing. And the process-implementation
doctrine *requires* portability: `GitHubPullRequestsLive` should be
one generic Layer; if its release-cadence mandate consumed
`Cloudflare.Workers.CronEventSource` directly, the implementation
would be environment-specific and the one-implementation thesis breaks.
The existing Cloudflare tag keeps its platform-specific surface
(`ScheduledController`, `noRetry` — real workerd semantics, rightly
exposed at that level); the portable tag layers over it.

**Contract sketch.**

```ts
export class Scheduler extends Context.Service<Scheduler, {
  /** Register a recurring mandate. Provision-at-plan / deliver-at-runtime,
   *  the one-call-two-halves shape. Handler failures are the handler's
   *  problem (Effect.retry inside); the scheduler never crashes the host. */
  every(cron: string, handler: (fire: { expression: string; firedAt: Date }) =>
    Effect.Effect<void>): Effect.Effect<void>;
}>()("alchemy/Scheduler") {}
```

**Layers.** `LocalScheduler` (an `Effect.repeat` fiber with
`Schedule.cron`; fires while the laptop process runs — honest fidelity
note: no catch-up for missed fires, mirroring the polling
EventSource's documented limits) · `CloudflareScheduler` (adapts the
shipped `CronEventSource` — `src/Cloudflare/Workers/CronEventSource.ts:216-255`
already does provision + listen; the portable Layer is ~20 lines over
it) · `AWSScheduler` (EventBridge Scheduler — the resources exist,
`src/AWS/Scheduler/Schedule.ts`).

**Wraps / maps to.** Orleans reminders-vs-timers is the exact durable
vs in-memory split (our durable variant is "platform cron"; the local
fiber is the timer). Devin Schedules, Warp Oz schedules-as-triggers,
Temporal Schedules, CI `schedule:` — every platform ships it.

**Consumers.** Release train (the cadence mandate), autoresearch (the
weekly system loop — §8.2 ring 5's schedule-triggered outer loop, per
Warp's improvement loop), stale-work sweeps (the §8.4 "absence
trigger" gap: "when X has been silent for N days" is implementable
today as a cron mandate + a query, no new trigger construct).

**Priority: P1.** Nothing in the P0 flywheel needs it; the release
train (the first composed process, §5) does.

### 3.6 `TraceStore` — the durable log (Tracker, reframed)

**Responsibility.** The append-only, seq-cursored event log behind
`kernel.trace(ring, after?)`: commit transactionally, replay-then-tail
with no gap, never store live deltas. Already a shipped
`Context.Service` with the memory Layer
(`src/AI/TraceStore.ts:33-55, 126-129`).

**The reframe.** The prompt's candidate was "Tracker/Evals
(Trace-derived metrics; the autoresearch input)". Split it: the
*storage seam* is TraceStore and it's real (this entry); the *evals*
are consumers — folds and processes over `kernel.trace` +
`AI.observe(ring)` (`src/AI/Observe.ts`: trace access without
capability inheritance) — and making them a component would contradict
the strongest convergence in the harness survey (§9.2: "one event log
as the single representation" for memory, replay, observability, and
autoresearch; nobody ships a second metrics plane). LangWatch's
"shadow stack" point (every loop carries a measurement
responsibility) is honored by the *doctrine* that every factory
process is observable via its ring's trace — not by new surface.
Export-to-OTel/Axiom is a Layer decoration on TraceStore, not a tag.

**Layers.** `TraceStoreMemory` (shipped) · `TraceStoreDO` (DO SQLite
hot — the two-plane Ring state, §3.1) · `TraceStoreR2` (cold tier)
· `TraceStoreSqlite` (laptop persistence so a killed local factory
keeps its history — pairs with `SqliteLedger` in the restart-resume
demo) · OTel exporter decoration.

**Consumers.** The kernel (durability), folds (memory), `AI.observe`
(autoresearch input), Warp-style intervention telemetry ("every human
intervention is recorded telemetry the improvement loop consumes" —
our Ask answers are already Trace rows), Devin-style session insights
(a fold over completed runs).

**Priority: P1** for the durable Layers (the local demo works on
memory; deployment doesn't). The eval *processes* are app code and get
prioritized like any other charter.

### 3.7 `ArtifactStore` — blobs that outlive a run

**Responsibility.** Durable, keyed blobs that cross run and
environment boundaries: case files, Engineer→Reviewer hand-off notes,
generated fixtures, rendered release notes, eval reports. Distinct
from TraceStore (events, not blobs), from Workspace (ephemeral, scoped
to a checkout), and from the world's own artifact surfaces (a PR *is*
the flywheel's primary artifact and lives on GitHub — which is why
this component is P2, not P1).

**Contract sketch.**

```ts
export class ArtifactStore extends Context.Service<ArtifactStore, {
  put(key: string, body: Uint8Array | string, opts?: { contentType?: string }):
    Effect.Effect<void>;
  get(key: string): Effect.Effect<Uint8Array, ArtifactNotFound>;
  list(prefix: string): Effect.Effect<ReadonlyArray<{ key: string; size: number }>>;
}>()("alchemy/AI/ArtifactStore") {}
```

**Naming hazard.** `packages/alchemy/src/Artifacts.ts` already exports
`Artifacts` *and* a class literally named `ArtifactStore` — the deploy
engine's per-resource, per-run memo bag. The factory component must
pick a non-colliding tag (`CaseFiles`? `BlobStore`?) or the engine
one gets renamed; flagging before someone loses an afternoon to it.

**Layers.** `FsArtifactStore(dir)` (local) · R2 (the R2 capability
Layers in `src/Cloudflare/R2/` are the plumbing) · S3.

**Wraps / maps to.** Factory Missions' shared state is *artifacts by
doctrine* ("the full state is distributed across shared artifacts: the
validation contract, the feature list, research notes… an evolving
knowledge base"); Warp auto-tracking's recorded run artifacts; Devin
attachments; Osmani's "the state file is the spine of the whole thing…
The agent forgets, the repo doesn't"; CI artifacts/cache.

**Consumers.** Fix hand-offs (review attached as new acceptance
criteria — today that rides the dispatch payload; fine until it
isn't), autoresearch reports, release-note drafts, skill content
(§6 — skills are terms, their *bulk content* is artifacts).

**Priority: P2.** Every near-term artifact has a better home: PRs and
comments live on GitHub (world outranks org — reconciler doctrine),
folds live in the kernel, events in the Trace. Build when the first
blob demonstrably has no world surface — likely the autoresearch
report or a case file exceeding comfortable dispatch-payload size.

### 3.8 `Notifier` — outbound announcements

**Responsibility.** Fire-and-forget, deterministic outbound messages
to a surface — "engineering started on #123", "release v2.0.0-beta.46
cut" — sent by *deterministic* code (process implementation Layers,
front doors), not by charters (a charter that needs to speak uses a
Tool like `Comment`, which stays a tool: it is capability, prose-
granted, surface-specific).

**Why it survives (barely).** The narrow case: a process
implementation Layer that wants to announce lifecycle facts must not
hard-code a surface, or the one-generic-implementation thesis breaks
(the local factory announces to stdout; the deployed one to Discord).
That is a genuine environment seam. Everything else about
notifications is either a Tool (in-charter) or an EventSource consumer
(org events like `EngineeringStarted` — `services/alchemy-org/src/flywheel.ts:37-40`
— already broadcast on the EventBus; a Discord bridge is *a subscriber*,
which needs the sending SDK but not necessarily a component).

**Contract sketch (minimal to the point of austerity).**

```ts
export class Notifier extends Context.Service<Notifier, {
  notify(topic: string, message: string): Effect.Effect<void>;
}>()("alchemy/Notifier") {}
```

**Layers.** `ConsoleNotifier` (local) · `DiscordNotifier(channel)` ·
`SlackNotifier(channel)` · `GitHubCommentNotifier(issueRef)` (announce
on the originating issue — often the honest place).

**Priority: P2.** Defensible to kill entirely and let the EventBus-
subscriber pattern carry it; kept because the stdout-vs-Discord swap
is exactly the demo's local/cloud story and costs ~30 lines. If the
first implementation ends up with routing logic (which topics go
where), that's the signal it's becoming an app concern — stop and
revert to subscribers.

### 3.9 `ModelProvider` — note only

Already a Layer and already the industry's settled shape:
`AnthropicLanguageModel.layer({...})` over an HTTP client
(`services/alchemy-org/src/worker.ts:85-99`); Cloudflare's AI Gateway
Layers exist (`src/Cloudflare/AI/{LanguageModel,Gateway}.ts`); Bedrock
would be the AWS Layer. The one design note worth restating from §9.3:
model choice is **per-turn data resolved at interpretation** (kernel
default ← ring policy ← agent Layer override), so Judge-on-cheap-model
needs no recomposition. No work item here beyond what the kernel
already owes.

---

## 4. Cross-reference — the catalog against external decompositions

Read across a row to see the convergence; read down the external
columns to check for components *they* have that we lack.

| Ours | Warp Oz | Devin | Factory.ai | Temporal/Restate | Orleans | CI/CD |
|---|---|---|---|---|---|---|
| Ledger | orchestration layer ("system of record") | sessions + queue | mission state | matching / task queues; virtual-object single-writer | grain directory + stream cursors | run queue |
| EventSource family | integrations (first-party vs custom) | ticket/Slack entry points | signals ("from outside the codebase") | signals-with-start | streams (pluggable providers) | `on:` triggers |
| Workspace | Environments + hosting (E2B/Daytona named) | Devbox + snapshots | sandboxed dev environments | — (out of scope) | — | runner + checkout |
| HumanGate | configurable checkpoints | approvals in sessions | plan-approval gate; "you're the project manager" | signals/updates; awakeables | — | environments' required reviewers |
| Scheduler | schedules-as-triggers | Schedules API | — | Temporal Schedules; durable timers | reminders (durable) vs timers | `schedule:` |
| TraceStore | auto-tracking (transcripts, artifacts, "how it reasoned") | session insights (as consumer) | OpenTelemetry + shared knowledge updates | event history / journal | log-storage persistence provider | logs + checks API |
| ArtifactStore | run artifacts | attachments | shared artifacts (validation contract, notes) | — | — | artifacts + cache |
| Notifier | task status surfaces | Slack/ticket posting | ticket status updates | — | — | status checks, badges |
| ModelProvider | model config per run | `devin_mode` tiers | model router + `missionModelSettings` per role | — | — | — |

What the external columns have that the catalog lacks, and why each is
deliberately absent:

- **Playbooks (Devin) / Skills (Warp).** Terms, not services — the
  canon's Skill term (P1) with content in artifacts. A "playbook
  store" is ArtifactStore + the term registry that already exists as
  source code (the constitution-file doctrine: the org's processes are
  a greppable module, not rows).
- **Knowledge / DeepWiki (Devin) / Knowledge Droid (Factory).** An
  index over repos is a *capability* (a search tool backed by
  Cloudflare AI Search — `src/Cloudflare/AI/Search*.ts` exists) plus
  artifacts. Making "organizational memory" a component would
  contradict §9.2's finding that memory seams are private to
  implementations.
- **Coordinator/Orchestrator (Factory), model router as learner.**
  Factory's orchestrator is a *process* (a charter with a planning
  responsibility), not infrastructure; §9.5 already rejected
  LLM-router orchestration as a primitive after the Mastra evidence.
- **Billing/consumption APIs (Devin enterprise).** Ours is the Budget
  Layer + Trace-derived accounting (§9.3 budget-per-command doctrine);
  a reporting surface is a fold.
- **Audit logs.** The Trace with `auth` provenance *is* the audit log
  (§9.3 amendment) — a separate component would be a second transcript,
  which the two-plane doctrine forbids.

The completeness check runs the other way too: nothing in the nine
components lacks at least two independent external analogs. The
catalog is neither invented nor exhaustive of what platforms ship —
it is the intersection that survives our doctrine.

---

## 5. Composition upward — the recursive step

### 5.1 The mechanism: interfaces on processes, Layers all the way up

The plan's `AI.Process<Self, Interface>` parameter is what makes
composition typed. A process's tag resolves to
`ProcessService & Interface` — the actor verbs plus author-declared
domain operations — and an implementation is an ordinary
`Layer.effect(Term, …)` that must return that interface. The
consequence for composition is exact: **a process is consumable by
other processes in precisely the way a component is** — `yield*` the
tag, call typed methods — so the factory's recursion needs no new
construct. A higher-level process's charter splices child processes
(`${GitHubIssues}` grants consultation, per the unmarked-grant rule);
its implementation Layer yields their tags and orchestrates over their
*declared interfaces*, deterministically or via codemode.

The components of §3 and the processes of the org therefore have the
same composition algebra:

```
Layer.provide direction (who satisfies whom):

  ReleaseTrainLive
    ├─ GitHubIssuesLive          ← a PROCESS as a dependency
    │    ├─ Ledger               ← components
    │    ├─ GitHub.RepositoryEventSource
    │    ├─ AI.Kernel
    │    └─ Engineer / Reviewer  ← agents (whose Layers close over Workspace physics)
    ├─ GitHubPullRequestsLive
    ├─ Scheduler                 ← component (the cadence mandate)
    ├─ Notifier                  ← component (the announcement)
    └─ AI.Kernel
```

Nothing distinguishes the process-dependency edges from the
component-dependency edges except what's behind the tag — which is the
thesis: **processes are components whose implementation happens to
contain judgment.**

### 5.2 Worked sketch: `ReleaseTrain`

The charter (interface declared in the type; cadence NOT in prose —
the mandate arrives as a message, per front-door doctrine):

```ts
export class ReleaseTrain extends AI.Process<ReleaseTrain, {
  /** The interface other processes and dashboards consume. */
  lastRelease(): Effect.Effect<ReleaseRef | undefined>;
  pending(): Effect.Effect<ReadonlyArray<PullRequestRef>>;
}>()("ReleaseTrain")`
You cut releases for the ${alchemy} repository. When a release mandate
arrives, consult ${GitHubPullRequests} for what has merged since the
last release and ${GitHubIssues} for what those changes resolved. If
nothing shipped, decline the mandate and say so. Otherwise draft the
changelog from the merged work — PRs cited inline, external
contributors credited — then ${CutRelease}, and announce
${ReleasePublished}.
${AI.exit(AI.until(ReleaseVerdict))`a release is cut or the mandate is
declined with the reason`}` {}
```

The one implementation, written against seams; environment nowhere in
it:

```ts
export const ReleaseTrainLive: Layer.Layer<
  ReleaseTrain,
  never,
  | AI.Kernel
  | Scheduler                    // the cadence mandate (component, §3.5)
  | GitHubPullRequests           // a PROCESS consumed via its declared interface
  | GitHubIssues                 // likewise
  | Notifier                     // the announcement (component, §3.8)
  | CutRelease | GitHub.Octokit  // its own tool + plumbing
> = Layer.effect(ReleaseTrain, Effect.gen(function* () {
  const kernel = yield* AI.Kernel;
  const inner = yield* kernel.interpret(ReleaseTrain);
  const prs = yield* GitHubPullRequests;   // typed: verbs + listOpen()
  const scheduler = yield* Scheduler;
  const notifier = yield* Notifier;

  // the mandate is a delivery, not kernel magic: cron → send
  yield* scheduler.every("0 9 * * MON", () =>
    inner.send({ kind: "release-mandate", firedAt: new Date() }));

  return {
    ...inner,
    lastRelease: () => /* Octokit releases.getLatest */,
    pending: () => prs.listOpen(),   // ← composition over a process's interface
  };
}));
```

Notes on what the sketch demonstrates:

- **`prs.listOpen()` is the recursive step in one line** — a process
  consuming a process through the same typed-tag mechanism it uses for
  a Ledger. No RPC layer, no registry: `Layer.provide` closes the
  graph, and on Cloudflare the kernel Layer's routing (interpret =
  client handle into the term's DO) makes the same line a cross-DO
  call without the sketch changing.
- **Deterministic vs codemode orchestration is the implementation
  Layer's private choice.** This Layer routes the mandate into the
  charter (AI judgment decides ship/decline); a stricter org could
  implement the same tag with `AI.process(ReleaseTrain, handler)` —
  fully deterministic, Reviewer-style leaves only — and no consumer
  would know. That is the canon's §1.2 Layer-choice doctrine surviving
  composition.
- **Where codemode enters:** when the orchestration itself is
  open-ended ("study what merged and decide *how* to group the
  changelog"), the charter's interpretation under
  `AI.ToolMode.codemode` writes code against the *same declared
  interfaces* — the `${GitHubPullRequests}` grant compiles to a typed
  client in the codemode sandbox. Declared interfaces are what make
  codemode orchestration typable at all; without the Interface
  parameter the model would be pushing untyped verbs.

### 5.3 The self-referencing factory

The org that maintains alchemy includes `services/alchemy-org` in its
own maintained surface. Concretely, with the components in place:

1. **An issue against the org's own charters** ("the Reviewer merges
   too eagerly") flows through the same flywheel: Engineer's Workspace
   checks out the repo that contains `services/alchemy-org/src/*`; the
   fix is a prose diff to a charter or a Layer swap; the Reviewer
   reviews it like any PR.
2. **Hot swap is redeploy**: the charter's `promptHash` changes, the
   canon's hot-code-swap story (§0 pitch) applies, and runs started
   under the old hash carry it in their checkpoints (checkpoint-fossil
   doctrine, §9.3).
3. **The system loop is a composed process with structurally less
   authority than what it studies**: an `Autoresearch` process whose
   charter splices `${AI.observe(GitHubIssues)}` +
   `${AI.observe(GitHubPullRequests)}` (trace access, no capability
   inheritance — `src/AI/Observe.ts`) + a Workspace + `OpenPullRequest`
   — and, decisively, **no `${Approve}` and no `${MergePullRequest}`**.
   Its output is PRs against the org's own typed source, review-gated
   like Warp's skill-file PRs ("humans decide what improves; agents
   propose it" — the §8.4 conservative stance, kept). Capability
   fencing by omission is what makes self-reference safe rather than
   scary: the loop that rewrites the org cannot ratify itself.
4. **What bounds the recursion is the oversight ring** — the source
   file, code review, `alchemy deploy` (§8.2: the top ring's exit is
   "yours to call", unwired on purpose). The components give every
   inner ring a place to stand; none of them gives any ring authority
   over its own review.

The claim to carry forward: with the nine components and the Interface
parameter, "generic software engineering and most knowledge work" is
expressible as compositions because every process reduces to: messages
in (EventSource family / Scheduler / dispatch), dedupe (Ledger),
judgment or code (Kernel Layers), capability (tools over Workspace and
provider SDKs), human authority (HumanGate), record (TraceStore /
ArtifactStore), messages out (Notifier / world side effects / typed
interfaces). A support desk, a release train, an autoresearch loop,
and an issue flywheel are the same eight seams in different
proportions. What is *not* claimed: that the catalog anticipates every
future seam — the extraction doctrine exists because it won't.

---

## 6. What NOT to build

Rejections, with the evidence that settles them (kept so they aren't
relitigated — the removed-concepts-ledger discipline):

| Rejected | Why | What replaces it |
|---|---|---|
| **Generic `EventIngress` super-interface** | erases the per-provider typed payload unions that are the existing tag's entire value; redundant with `AI.EventChannelService` one level up | one tag per provider family (the pattern), shared path/secret helpers when provider #2 lands (§3.2) |
| **`RunRegistry`** | "a run is active is derivable, never resurrected" (§9.5, from OpenCode); Warp's system-of-record maps to Ledger + Trace, which we have | interface methods on processes (`listIssues()`, `pending()`) + folds over `kernel.trace`; an org dashboard is an app |
| **Evals/Tracker component** | the one-log convergence (§9.2): memory, replay, observability, and autoresearch all read the same Trace; a metrics plane would be a second transcript | eval processes with `AI.observe`; OTel export as a TraceStore decoration |
| **Orchestrator/Coordinator service** | Factory's orchestrator is a role, not infrastructure; Mastra networks (LLM-router orchestration) already rejected at 2.7k lines and self-admitted hallucination (§9.5) | charters that splice processes; deterministic handlers; codemode over declared interfaces |
| **KnowledgeStore** | memory seams are private to implementations (§9.2 #5); "organizational knowledge" decomposes into search capability + artifacts + folds | a search Tool (Cloudflare AI Search exists), ArtifactStore, fold snapshots |
| **SecretStore** | alchemy resources + bindings already own secrets end to end (GitHub Secrets, Worker bindings, `webhookSecretEnvName`) | existing resource machinery |
| **A generic `serve`/router for processes** | already killed by the plan (FrontDoor deletion): declaring an interface *obligates* a hand-written Layer; a router would re-centralize what Layers decentralize | implementations own delivery |
| **Fan-out / MapReduce primitive** | §8.5 verbatim: "fan-in requires barrier synchronization", not a closing signal | `Effect.forEach` + `concurrency` inside a body |
| **Workflow-engine dependency (Temporal/Restate as substrate)** | canon removed-concepts ledger (`effect/unstable/workflow` rejection); the Trace **is** the ledger; adopting an engine would put the factory's spine outside the Layer model | kernel-owned durability; CF Workflows evaluated as a *Layer's* substrate only (§3.2 ladder) |
| **Ledger `claim`/lease (today)** | no call site decouples delivery from execution outside the kernel | note in the contract docs; revisit with the first fleet-without-serializer physics |

The pattern in the rejections: everything killed was either **app code
wearing a component costume** (registry, evals, knowledge), **a role
mistaken for infrastructure** (orchestrator), or **a second copy of
the one log** (metrics, audit). The survey's §9.2 lesson generalizes:
the platforms that lasted put fewer things in the kernel than their
first drafts did.

---

## 7. Adoption order for `services/alchemy-org`

Sequenced by what each unblocks, honoring the plan's "TaskQueue is the
only component built in this arc":

1. **Now (plan Phase B, in flight):** `Ledger` (Memory → Sqlite → D1)
   + `RepositoryEventSourcePolling` — the two seams the one-generic-
   implementation thesis is being proven on. Adopt the three-valued
   `offer` question (§3.1) into the Phase-B test plan (re-admission of
   a settled key is already a scripted-test case; make it decide the
   contract).
2. **With the first real Engineer run:** `LocalWorkspace` — built
   *inside* `localToolbox` first (clone + exec + diff over
   `FileSystem`/child process), extracted to the `Workspace` tag when
   `devboxToolbox` becomes the second call site. Replaces the
   `layers.ts` stubs.
3. **With the Reviewer going live:** `AskHubConsole` (laptop approvals
   on stdin) and, in the same stroke, the GitHub-review-as-answer
   pattern for `Approve` — it needs only event-source plumbing that
   step 1 already provides. This is the autonomy dial working locally.
4. **With deployment (worker.ts stops being aspirational):**
   `TraceStoreDO` + `AskHubDurable` on the same D1/DO substrate the
   Ledger brought; the webhook EventSource Layer is already shipped.
5. **With the second process wave (`ReleaseTrain`):** portable
   `Scheduler` (the Cloudflare adapter is small; the local fiber
   smaller) + `Notifier` (console | Discord). This is also when the
   Interface-parameter composition (§5.2) gets its first real consumer
   and the recursive claim is tested against a compiler instead of
   this report.
6. **When a blob has no world surface:** `ArtifactStore` (renamed to
   dodge `src/Artifacts.ts`) — expected trigger: autoresearch's first
   report or an oversized review hand-off.
7. **Discord/Slack EventSource families** ride whichever comes first:
   the support-desk process or the Slack HumanGate Layer.

Promotion to core (`packages/alchemy`) stays evidence-gated per the
plan: a component graduates when both physics work and a second
*service* (not just a second process in alchemy-org) wants it.
Expected graduation order: Ledger → Workspace → Scheduler; the AI-side
components (TraceStore, AskHub) are already in core.

---

## 8. Honesty notes

- **No code was run** (per constraints): no type-check, no tests. The
  contract sketches are written against read source and the plan's
  conventions, not compiled. In particular the `ReleaseTrain` sketch
  assumes the `AI.Process<Self, Interface>` parameter (plan Phase A,
  in progress) and the `AI.until(ReleaseVerdict)` exit shape — both
  in-flight designs whose final spellings may differ.
- **The `services/alchemy-org` tree read here is pre-plan**: it still
  uses `GitHub.frontDoor(ResolveGitHubIssue)` (`worker.ts:103-107`)
  and a single `ResolveGitHubIssue` process, not the
  `GitHubIssues`/`GitHubPullRequests` pair the plan describes. Claims
  about "the concrete pattern being built" cite the plan's target
  state; claims about existing code cite the tree as read on
  2026-07-16.
- **External platform claims are from vendor docs and secondary
  coverage** (Warp docs, Devin docs, Factory.ai posts, a 2026
  durable-workflow survey blog, Orleans docs) fetched 2026-07-16.
  Vendor docs describe intended architecture, not verified internals;
  the Devin "compound AI system" details in particular came from a
  third-party guide of uncertain reliability and were used only for
  the API-surface enumeration (which is first-party). No Cursor
  background-agent or Google Jules primary source made it into the
  cross-reference table — searches surfaced marketing-grade material
  only; the table's claims don't lean on either.
- **The Slack Socket Mode and Stripe `/v1/events` polling claims**
  (§3.2 Layers table) are from prior knowledge of those platforms,
  not verified this session against current API docs. Both are
  long-stable APIs; verify before building those Layers.
- **The Workspace contract omissions** (no typed fs ops, no snapshot
  in core) are predictions about what the two call sites will need,
  made before either exists — exactly the speculation the extraction
  doctrine warns about. The mitigations: the contract is presented as
  a sketch, and the adoption order builds the physics inside
  `localToolbox` before extracting the tag.
- **The "three-valued `offer`" recommendation (§3.1)** is an inference
  from the canon's re-admission door, not a failure observed in
  running code. The Phase-B scripted test (redelivery + settled-key
  re-admission) will confirm or kill it.
- **The §5.3 self-reference walkthrough is architecture, not
  experience**: nothing has yet round-tripped a charter-editing PR
  through the flywheel. The nearest evidence is Warp's skill-file-PR
  loop (vendor-reported) and Meta's negative result on open-ended
  self-modification (§8.3), which is why the walkthrough leans so
  hard on capability-by-omission.
- **Line-number citations** were verified against the tree as read on
  2026-07-16; the AI-package files are under active refactor — Phase A
  landed in the working tree *during this session* (`FrontDoor.ts` and
  its test are now deleted; `Process.ts`/`Kernel.ts` modified), so the
  §6 "generic serve/router" rejection is already literal, and the
  `services/alchemy-org/src/worker.ts:103-107` `frontDoor` citation
  describes code that no longer compiles against core. Citations into
  the AI package will rot fastest.
