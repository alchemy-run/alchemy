# Control Loops and Reconciliation: MAPE-K, Kubernetes Controllers, Control Theory, and OODA vs the Alchemy Charter Model

Research memo: the engineering of perpetual goal-seeking systems — IBM's
autonomic computing loop, Kubernetes controller doctrine, control-theory
vocabulary, constant-work systems, and Boyd's OODA — as a lens on Alchemy AI's
charter/stance/kernel design. One of nine parallel paradigm studies.

## 1. The paradigms (precise semantics)

### Control theory vocabulary

A feedback controller has four nouns: the **setpoint** (SP, desired state), the
**process variable** (PV, measured current state), the **error** `e = SP − PV`,
and the **actuation** `u` applied to close the error. The loop runs forever; it
has no exit condition, only quiescence at `e ≈ 0`. Two distinct jobs share the
same loop: **setpoint tracking** (the operator changed the spec; chase it) and
**disturbance rejection** (the world changed on its own; correct it). A
level-triggered reconciler treats both identically — it only ever sees the gap.

PID intuition: the **proportional** term responds to present error, the
**integral** term accumulates past error (eliminating steady-state offset, but
risking **windup** when the actuator saturates), the **derivative** term damps
by anticipating. The canonical failure mode is **oscillation**: a correction
overshoots, triggers a reverse correction that also overshoots, and the system
thrashes. Standard damping tools, all of which appear in Kubernetes' HPA and in
every production autoscaler: **cooldown periods** (no re-actuation within N
seconds of the last action), **rate limits** (max change per period),
**hysteresis** (different thresholds for opposite actions — scale up at 80%,
down at 50% — so the system cannot flip on a boundary), and smoothing (moving
averages before the controller sees the signal).

### MAPE-K (IBM autonomic computing)

IBM's blueprint dissects an "autonomic manager" into four functions sharing a
fifth component: **Monitor** (collect, aggregate, filter data from the managed
resource via *sensors*), **Analyze** (correlate and model — determine *whether*
change is needed, including prediction), **Plan** (construct the actions to
achieve goals, guided by *policy*), **Execute** (carry the plan out via
*effectors*, with on-the-fly updates), all over shared **Knowledge** (topology,
logs, metrics, policies — written by Monitor, read by all). The blueprint's
less-quoted second half matters here: autonomic managers **compose** — they
expose their own sensors/effectors upward, forming hierarchical and
peer-to-peer arrangements ("orchestrating managers" over "resource managers"),
and a manager can be *partial* (only M+E automated, human doing A+P — their
maturity model is literally a scale of how much of the loop is delegated).
Kephart & Chess's companion vision paper contributes the self-* taxonomy
(self-configuring/healing/optimizing/protecting) and the framing that the human
role shifts from direct control to **policy authorship** — the human writes
goals, the loops pursue them.

### Kubernetes controllers: level-triggered reconciliation

The single most load-bearing sentence in controller-runtime's godoc:
"Reconciliation is **level-based**, meaning action isn't driven off changes in
individual Events, but instead is driven by actual cluster state read from the
apiserver or a local cache." The event system exists, but events are **only
hints to wake up**: the work item is a *key* (namespace/name), never a payload.
"Events tell you *when* to reconcile, never *what* to do." Consequences:

- **Missed events are harmless.** A dropped watch, a controller crash, a
  network partition — on the next wake (or resync) the controller re-observes
  and corrects the same drift. Edge-triggered systems that miss an event are
  *permanently wrong* until an external actor replays history.
- **Reconcile(key) is idempotent** and convergent: running it ten times equals
  running it once. It can therefore be invoked spuriously, concurrently-ish
  (the workqueue serializes per key), and on a timer.
- **The workqueue dedupes**: 100 events for one key collapse into one pending
  reconcile. Retries get **per-item exponential backoff** (5ms → 1000s in
  client-go's default) *plus* a **global token bucket** (10 QPS, burst 100)
  so a mass failure can't stampede the API server.
- **Periodic resync** re-enqueues every object on a timer — drift insurance
  for whatever the event stream lost.
- **Spec vs status**: desired state (`spec`, written by users) and observed
  state (`status`, written only by the controller, via a separate subresource
  endpoint) are structurally separated; `status.observedGeneration` records
  which version of intent the controller has caught up to.
- **"Don't fight controllers"**: exactly one controller owns each object
  (ControllerRef); overlapping ownership is documented to "thrash objects
  back-and-forth" and destabilize the API server. Single-writer-per-aspect is
  a stability precondition, not a style preference.
- **Finalizers** gate deletion until cleanup converges — teardown is itself a
  reconcile.

### Constant work

MacCárthaigh's argument ("Reliability, constant work, and a good cup of
coffee"): the most reliable control planes do **the same work regardless of
input volume** — e.g. push the *entire* config table to S3 every few seconds
whether or not anything changed, and have data planes fetch and apply the whole
thing every time. Three properties: no scaling with load or stress, **no
modes** (identical operations in all conditions — the recovery path IS the
normal path), and where there is variation, it's *less* work under stress
(anti-fragility). The alternative — doing work proportional to changes — is
exactly what melts down when a burst of changes coincides with the stress that
caused them. Constant work is level-triggering taken to its limit: the full
state transfer every period *is* the resync, and there is no separate
"catch-up" mode to get wrong.

### OODA

Boyd's loop — Observe, Orient, Decide, Act — is not the four-box cycle of the
management slides. In his actual diagram, **Orient is the Schwerpunkt**: it
holds the mental models (culture, experience, prior analysis) that *filter
observation itself* (a feed-forward arrow from Orient back to Observe), and it
has a direct channel to Act that **bypasses Decide** entirely ("implicit
guidance and control") — trained pattern-recognition acting without
deliberation. Tempo is *relative*: operating "inside" an opponent's loop means
your orientation matches reality better and updates faster than theirs, not
that you merely act quickly. The failure mode of fast-but-wrong orientation is
being "faster at being wrong."

## 2. Primary sources

Read directly (full text or substantial extracts pulled during this research):

- IBM, *An Architectural Blueprint for Autonomic Computing* (2005/2006 white
  paper): <https://www.jroller.org/autonomic/pdfs/ACwpFinal.pdf> — read the
  autonomic-manager dissection (§2.4), shared knowledge (§2.6), and the
  manager-collaboration/hierarchy section (§2.5).
- Kephart & Chess, *The Vision of Autonomic Computing*, IEEE Computer 2003:
  <https://www.cs.cmu.edu/~15849g/readings/kephart03.pdf> — self-* taxonomy,
  policy-as-human-interface.
- controller-runtime `Reconciler` godoc (the "level-based" definition, requeue
  and backoff contract):
  <https://github.com/kubernetes-sigs/controller-runtime/blob/v0.23.3/pkg/reconcile/reconcile.go>
- client-go `DefaultControllerRateLimiter` source (per-item exponential ×
  global token bucket):
  <https://github.com/kubernetes/client-go/blob/master/util/workqueue/default_rate_limiters.go>
- James Bowes, *Level Triggering and Reconciliation in Kubernetes*:
  <https://medium.com/hackernoon/level-triggering-and-reconciliation-in-kubernetes-1f17fe30333d>
  — the signal-processing framing; edge systems recover via "periodic
  reconciliation with the full state."
- PlanetScale, *The feedback loops behind Kubernetes*:
  <https://planetscale.com/blog/the-feedback-loops-behind-kubernetes> —
  "edge-triggered notifications, level-triggered logic"; setpoint tracking vs
  disturbance rejection.
- Kubernetes ControllerRef design proposal ("don't fight controllers"):
  <https://github.com/kubernetes/design-proposals-archive/blob/main/api-machinery/controller-ref.md>
- Daniel Mangum, *Rate Limiting in controller-runtime and client-go*:
  <https://danielmangum.com/posts/controller-runtime-client-go-rate-limiting/>
  and Stuart Leeks, *Error Back-off with Controller Runtime*:
  <https://stuartleeks.com/posts/error-back-off-with-controller-runtime/>
- MacCárthaigh, *Reliability, constant work, and a good cup of coffee* (full
  text reprinted): <https://www.allthingsdistributed.com/2023/11/standing-on-the-shoulders-of-giants-colm-on-constant-work.html>
  plus his talk thread: <https://threadreaderapp.com/thread/1071084058841559041.html>
- Boyd, *Organic Design for Command and Control* (slides):
  <https://ooda.de/media/john_boyd_-_organic_design_for_command_and_control.pdf>
  — "Orientation is the Schwerpunkt"; plus two close readings of the 1995
  diagram: <https://tomorrowdesk.com/info/ooda-loop>,
  <https://garden.johanneskleske.com/ooda-loop>
- Åström & Hägglund, *Advanced PID Control* ch. 10 (windup, setpoint
  weighting): <http://www.cds.caltech.edu/~murray/books/AM05/pdf/am06-pid_16Sep06.pdf>

Consulted via excerpts quoted in the above (not fetched in full): the official
Kubernetes "Controllers" concepts doc
(<https://kubernetes.io/docs/concepts/architecture/controller/> — thermostat
analogy, "controllers may be forever toiling"), Burns, *Designing Distributed
Systems* (O'Reilly/Microsoft ebook).

Codebase read: `packages/alchemy/src/AI/{Kernel,KernelMemory,Prose,Run,Actor,Process}.ts`,
`services/alchemy-org/src/{issues,pull-requests,ledger}.ts`, and the
Reconciler-doctrine section of `AGENTS.md`.

## 3. Mapping to LLM agentic loops

The mapping is unusually direct because the kernel already has a tick with the
right shape. Per `KernelMemory`:

```
loop: drain mailbox → user messages
      TICK: evaluate turn → render stance → diff → toolkit
      generateText(head + transcript, toolkit)
      quiescent → PARK: wait for steer/send (wake) or settle (end)
```

| Control loops | Alchemy AI today |
| --- | --- |
| Managed resource / plant | The world (GitHub issue #7, PR #42) |
| Controller instance, keyed by object | Run, keyed by world identity (`owner/repo#7`) |
| Setpoint (spec) | The charter's stance ("issue triaged", "PR merged") |
| Process variable (observed state) | **Missing** — beliefs accumulated from event payloads in the transcript |
| Error signal | `<situation>` deltas (but derived from locals, not observation) |
| Actuators / effectors | Tools (`Comment`, `MergePullRequest`, …) |
| Monitor | `consumeRepositoryEvents` + Ledger (edge delivery, dedupe) |
| Analyze | Turn-effect branching on locals + LLM judgment |
| Plan | The model sampling |
| Execute | Tool handlers inside `generateText` |
| Knowledge | Transcript + `AI.local`s (+ nothing observed) |
| Reconcile wake-up | `send`/`steer` |
| Resync period | **Missing** — a parked run waits forever for a steer |
| Backoff / rate limiting | **Missing** — a crashed loop settles all waiters and dies; no retry, no actuation limits |
| Status subresource | Partially: the world's own artifacts (comments, labels) — unstructured |

### The edge-triggering finding (load-bearing)

The org's wiring is edge-triggered in exactly the sense the Kubernetes
literature warns about: `IssueCommented` → `steer(key, event)` delivers the
*payload* into the transcript, and the run's beliefs are the fold of every
payload it happened to receive. Three concrete failure modes, all present in
the current code:

1. **Missed events are permanent drift.** If the process is down when a
   comment lands and the webhook redelivery window is exhausted, the parked
   run never wakes; its stance says "awaiting author" forever while the author
   has long since answered.
2. **Restart loses runs but not Ledger state.** `KernelMemory`'s `runs` map is
   in-memory; the Ledger (sqlite/D1) persists admission. After a restart, a
   re-polled `IssueOpened` gets `duplicate` from the Ledger and is routed to
   `steer` — but `steer` against a key with no live run **silently no-ops**
   (`if (run === undefined) return;`). The event is dropped, the run is never
   recreated, and the issue is orphaned. This is the textbook edge-triggered
   crash-recovery failure, reproduced faithfully.
3. **Payloads are stale by construction.** A webhook payload is a snapshot at
   emission time. By the time the run samples, the issue may be edited,
   closed, or answered. The model reasons from the payload anyway.

Alchemy's own resource-provider doctrine already prohibits this: *"Observation
> assumption. Cloud state is authoritative. `olds` is at most a hint to skip a
no-op API call; it is never the source of truth."* The AI layer treats event
payloads as the source of truth — the transcript is `olds` promoted to
authority. The house doctrine and the Kubernetes doctrine agree; the AI layer
violates both.

The fix prescribed by both doctrines: **events become wake-ups; observation
becomes a phase**. On wake (and on resync), fetch the issue, its comments, its
linked PRs; render the stance *from that snapshot*; let the payload ride along
at most as a hint. Note a subtlety in the current design: the turn effect
*could* fetch GitHub today (Effect-valued splices are evaluated every tick),
but `Turn`'s error channel is `never` — an observation failure would be a
defect that kills the loop, and there is no caching, retry, or backoff story.
Observation needs a home with typed errors and kernel-owned retry. That is an
architectural argument for a distinct `observe` phase, not just charter
discipline.

### Stance as setpoint

Control vocabulary fits the charter model strikingly well and cleans up the
"phases" framing:

- The **stance is the setpoint plus the control policy**: it declares the
  desired world ("a ready issue is handed to Engineer") and how to close error
  ("Comment asks the author for exactly what is missing").
- A `<situation>` message is precisely an **error signal**: a rendered diff
  between the frozen head's world and the current one, with "latest
  supersedes" giving it level semantics *within the transcript* — a later
  situation overwrites an earlier one on the same matters. The delivery
  mechanism is already level-flavored; only its *input* (locals instead of
  observations) is edge-derived.
- The `phase` local (`triaging` ↔ `awaiting-author`) is **hysteresis**: two
  stances with an explicit band between them, transitioned by deliberate tool
  calls rather than flapping on every message. This is worth keeping and
  naming — phases are not a rival model to setpoints; they are the damping
  mechanism on the setpoint.
- OODA sharpens the tick: the turn effect is **Orient** — it is re-evaluated
  before *every* sampling, it shapes what the model attends to (the frozen
  head is crystallized orientation; feed-forward from Orient to Observe is
  literally "the stance decides what to fetch"), and the seat of judgment is
  there, not in the sampling. Boyd's implicit-guidance channel (Orient → Act,
  bypassing Decide) maps to deterministic actions taken by the turn/observe
  phase *without* a model call — park, settle, no-op — which is also the cost
  model's best friend: most resync ticks should end without sampling.

### MAPE-K decomposition and coordination

The blueprint's four functions land as: Monitor = event sources **plus the
missing observation phase**; Analyze = deterministic snapshot-diffing (kernel)
plus LLM judgment (model); Plan = the sampling; Execute = tools; Knowledge =
transcript + locals + **the observed snapshot**. Two things MAPE-K has that
alchemy lacks:

1. **Explicit shared knowledge between loops.** Issues and PullRequests each
   hold private beliefs about overlapping world objects (an issue and its
   fixing PR). MAPE-K makes the knowledge component a first-class, *shared*
   artifact. Alchemy's nearest analog — the world itself as the shared
   blackboard — is actually the *better* design (the world outranks the org's
   beliefs), but only if both loops **observe** the world rather than fold
   private event streams; observation is what makes the world function as
   shared knowledge.
2. **Manager composition contracts.** The blueprint's hierarchies work because
   each manager exposes sensors/effectors upward — an orchestrating manager
   *monitors its subordinate managers*. Alchemy's process → agent → spawn
   delegation passes tasks down but exposes nothing structured upward except
   the final answer; there is no way for `Issues` to observe the health/tempo
   of an in-flight `Engineer` dispatch (it blocks on `dispatch` instead). A
   `Process`'s Shape is the right seam for this — it just needs status verbs.

### Stability of coupled loops

Issues comments → PullRequests reacts → comments → Issues reacts is two
controllers actuating each other's process variable — the "fighting
controllers" configuration Kubernetes bans outright, and a positive feedback
risk (agents arguing in comments forever, each reply steering the other).
What the literature prescribes, translated:

- **Single-writer ownership** (already half-present via capability-by-omission:
  only PullRequests holds `MergePullRequest`). Extend the principle from
  *capabilities* to *conversations*: one process owns commenting on a given
  artifact class, or replies to org-authored comments are filtered out of
  wake-ups (the K8s analog: a controller ignores events caused by its own
  writes — otherwise every reconcile self-triggers).
- **Actuation guards in the kernel, not prose.** Kubernetes puts backoff and
  the token bucket in the *workqueue* — controller authors cannot forget it.
  Prose ("never re-ask an answered question") is policy the model can violate
  under drift; rate limits are physics. Per-run per-tool cooldowns and a
  per-process sampling token bucket belong in the kernel/Layer.
- **Hysteresis on wake-ups**: the existing situation dedupe (exact-text) is
  the seed; extend it so a parked run only wakes to sampling when the observed
  snapshot *materially* differs, with a cooldown floor so two coupled
  processes cannot ping-pong faster than the cooldown period.

### Resync and constant work

A parked run trusting steers to arrive is trusting exactly the delivery
guarantee GitHub doesn't make. K8s answer: periodic resync re-enqueues
everything; missed events become bounded-staleness instead of permanent drift.
MacCárthaigh's answer is stronger: make the poll the *primary* mechanism and
the webhook the latency optimization — fetch the full open-issues list every N
seconds regardless of change (constant work, no modes: the recovery path is
the normal path). For alchemy: **one** process-level list call per period
(`ListIssues` — already in `IssuesLive`'s closure), fanned out as per-run
snapshots, with jitter on per-run wakes so a thousand parked runs don't sample
simultaneously. Per-run polling (N `getIssue` calls) would scale work with run
count — burst-work; process-level listing is constant in event volume and
linear only in world size, which is the right shape. Where it lives: the
**schedule** in the kernel (it owns parking), the **observation effect** in
the charter/Layer (it owns world knowledge).

## 4. Comparison with alchemy's model

**Where the models already agree.** The run keyed by world identity *is*
`Reconcile(key)`. The tick re-evaluating the turn before every sampling *is*
level-triggered re-orientation — of the org's *policy*, if not yet of the
world. "Latest situation supersedes" is level semantics in-context. `settle`
being idempotent, world-owned, and no-op on unknown keys is the
delete-idempotency doctrine. The Ledger is the workqueue's dedupe half.
Capability-by-omission is ControllerRef. The bones are a controller; this is
not a rewrite question.

**Where they genuinely differ — and should.** A Kubernetes reconciler is
stateless between invocations: everything it needs is re-derivable from
spec + observed state. An agent run is *not* re-derivable from the world: the
transcript carries commitments made, questions asked, reasoning in flight,
tone. Discarding it per-tick (full level-triggering) would produce an amnesiac
that re-asks answered questions — the exact pathology the charter prose bans.
The resolution is the **spec/status split applied to the context window**: the
*head* is spec (frozen policy), *observations* enter as superseding situations
(level-triggered PV), and the *transcript* is the controller's own actuation
history (status: what I did, what I promised) — three channels with different
truth semantics, not one append-only fold. This also unlocks compaction:
superseded situations are dead weight by definition, and actuation history can
be summarized without touching either spec or PV.

**What breaks at scale under the current model.**

- *Drift*: every run's beliefs decay independently at the rate of missed and
  stale events; there is no correction mechanism at all — the failure is
  unbounded, silent, and per-run (§3's restart bug is drift's worst case:
  100%).
- *Flapping*: coupled processes with no actuation guards and sub-second loop
  latency; LLM loops flap *faster* than infra controllers because their
  "actuator" (a comment) is cheap and their "sensor" (the other loop's
  webhook) is immediate. Two chatty charters are an undamped positive loop
  spending real tokens.
- *Thundering herd*: naive resync wakes every parked run at once, each
  sampling a model — the burst-work anti-pattern; also every restart re-polls
  the world into a spike (a spike of *silently dropped* steers, today).
- *Unbounded context*: the append-only edge fold grows without a
  supersession-aware compaction rule.
- *No backoff*: a run whose loop fails dies permanently (settled-with-defect);
  a flaky tool or provider outage kills runs instead of backing them off —
  compare controller-runtime, where returning an error *is* the retry
  mechanism.

## 5. Steal / adapt / reject

### STEAL: observation as a charter phase (init → observe → turn)

Events become wake-ups; the turn renders from a snapshot. `observe` gets what
`Turn` structurally cannot have: a typed error channel, kernel-owned
retry/backoff, and caching.

```ts
// Charter shape: INIT once → { observe, turn }
const charter = Effect.gen(function* () {
  const phase = yield* AI.local<"triaging" | "awaiting-author">("triaging");
  const github = yield* GitHub.Issues(testAlchemy);

  return {
    // OBSERVE — before every tick AND on every resync wake. Typed
    // errors; the kernel retries with backoff and parks on exhaustion.
    observe: Effect.gen(function* () {
      const key = yield* AI.runKey;                    // owner/repo#7
      const issue = yield* github.get(key);            // GitHubApiError
      const comments = yield* github.comments(key);
      return { issue, comments } as const;             // the snapshot (PV)
    }),
    // TURN — pure orientation over snapshot + locals; still Effect<Fragment, never>
    turn: (world: IssueSnapshot) =>
      Effect.gen(function* () {
        return yield* AI.prose`
${issueSituation(world)}                                ${/* PV, superseding */""}
${(yield* phase.get) === "triaging" ? triagingStance : awaitingStance}`;
      }),
  };
});
```

The kernel renders the snapshot's blocks through the existing situation
machinery — observed state arrives as superseding `<situation>` messages, so
the PV is level-delivered into the context window with no new model-facing
protocol. Backward compatible: a charter returning a bare `Turn` is the
degenerate case (`observe = Effect.void`).

### STEAL: kernel resync schedules (missed-webhook insurance)

```ts
interface InterpretOptions {
  /** Wake parked runs to re-observe; jittered. Missed-event insurance. */
  readonly resync?: Schedule.Schedule<unknown>;        // e.g. spaced("10 minutes") + jittered
}

// in the park (KernelMemory loop):
const wake = yield* Effect.raceFirst(
  Effect.map(Queue.take(run.inbox), (input) => ({ _tag: "input", input })),
  Effect.map(Deferred.await(run.settled), () => ({ _tag: "settled" })),
  Effect.map(resyncTick, () => ({ _tag: "resync" })),  // from options.resync
);
// on resync: observe → diff snapshot blocks → unchanged? park again
// WITHOUT sampling (the no-op reconcile — Boyd's implicit path, $0 spent)
```

Constant-work variant for the Layer: one `ListIssues` per period feeds all
runs' snapshots (work independent of event volume), webhooks remain the
latency path. Also fixes the restart bug: a resync observing an open issue
with no live run re-admits it (requires the Ledger's three-valued
`accepted | duplicate | settled` — already an open TODO in `ledger.ts`).

### STEAL: workqueue discipline — backoff and actuation rate limits in the kernel

Guards are physics, not prose. Per client-go: per-item exponential backoff ×
global token bucket.

```ts
interface ActuationPolicy {
  /** Per-run loop failure → backoff and re-park, never settle-with-defect. */
  readonly retry: Schedule.Schedule<unknown>;          // exponential("5 millis") capped
  /** Global sampling budget across all runs of this interpretation. */
  readonly sampling: RateLimiter;                      // ~ token bucket (10 qps, burst 100)
  /** Per-(run, tool) cooldowns — the anti-flap floor on effectors. */
  readonly cooldowns?: Record<string, Duration.Duration>; // { comment: "5 minutes" }
}
```

A tool call inside cooldown returns a model-visible refusal (`failureMode:
"return"` already gives the channel): "you commented 90s ago; wait or park" —
the model learns the damping instead of fighting it.

### STEAL: don't fight controllers — self-event filtering

Each process ignores wake-ups caused by its own actuations (match on the org
bot's author id at the Layer's routing Match). Combined with per-tool
cooldowns this breaks the Issues↔PullRequests oscillation at both ends:
neither loop wakes on its own writes, and neither can reply faster than the
cooldown.

### ADAPT: control vocabulary over "phases" — but keep phases as hysteresis

Rename the mental model, not the machinery: stance = setpoint + policy,
situation = error signal, tools = actuators, turn = Orient. Phases stay,
reframed as hysteresis bands (deliberate, tool-transitioned stance switches
that prevent flapping) rather than a workflow. The doc-level payoff: charter
authors ask "what error does this stance minimize, and what damps it?" instead
of "what step comes next?"

### ADAPT: status — make runs legible to the world

K8s status subresource ≈ the run writing its observed-generation and progress
where the world (and other loops, and humans, and its own restart) can read
it. Cheapest version: the run's actuations *are* status (comments, labels) —
formalize with a convention (a label or comment marker carrying
`observedGeneration`-like info). This is what makes restart re-admission
convergent: a fresh run observes its predecessor's public status instead of
needing its lost transcript.

### REJECT: full statelessness (pure level-triggered re-derivation)

Do not discard the transcript and re-derive everything from observation each
tick. The transcript is the controller's internal state — commitments,
reasoning, conversational coherence. K8s controllers get statelessness because
their domain is fully externalized; conversation is not. Keep the three-channel
split (spec head / superseding situations / actuation history) instead.

### REJECT: PID numerics; event sourcing

Prose error is not a scalar; there is no meaningful integral or derivative
term to tune — take the qualitative stability toolkit (damping, saturation,
cooldown, hysteresis), not the math. And do not fix missed events by growing
the Ledger into an ordered, replayable event log (it is deliberately not a
task queue) — observation makes replay unnecessary; that is the entire point
of level-triggering.

## 6. Open questions

1. **Material-change detection for prose snapshots.** Exact-text block diffing
   flaps on timestamps and comment counts; too-loose diffing misses real
   changes. Canonicalize snapshots (strip volatile fields) in `observe`? A
   deterministic normalized-hash? An embedding threshold feels like a new
   failure mode, not a fix.
2. **Observation fan-out ownership.** Process-level list-then-fan-out is
   constant-work but couples the kernel's resync to a Layer-owned batch fetch.
   Does `observe` get a batched sibling (`observeAll: Effect<Map<key,
   Snapshot>>`), or does the Layer pre-warm a snapshot cache the per-run
   `observe` reads through?
3. **Durable runs.** Level-triggered observation makes restart re-admission
   *possible*; it doesn't decide what a resurrected run's context is. Seed
   from observation + public status only? The Ledger's three-valued `offer` is
   a prerequisite either way.
4. **Where Analyze's judgment threshold sits.** "Snapshot changed → sample" is
   deterministic Analyze; but some changes warrant no reaction (a +1 comment).
   Is a cheap-model classifier gate ever justified before waking the expensive
   loop, or is that premature — cooldowns may suffice?
5. **Oscillation observability.** Coupled prose loops admit no stability
   proof. What's the minimum: per-run actuation-rate metrics with an alert on
   sustained reciprocal actuation between two processes (the "fighting
   controllers" detector)?
6. **Compaction under supersession.** Situations are superseding by contract —
   old ones are provably dead context. Does the kernel prune them from the
   prompt it replays (cheap, mechanical), and does actuation-history
   summarization need the model or a template?
