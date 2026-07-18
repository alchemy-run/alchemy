# Grok Build engine patterns on effect/ai — implementation mapping

How Grok Build's engine patterns (the adversarial skeptic panel, evidence packets with
baselines, stall fingerprints, the goal pause taxonomy, the deterministic stop detector,
three-door steering, subagent auto-wake, repair-at-write-boundaries, the two-transcript
session store) map onto **effect v4's `effect/unstable/ai`** inside the Alchemy AI kernel
(Phase-2 step machine + memory kernel, Phase-3 Ring DO harness).

Every Grok Build claim is cited into `.vendor/grok-build/` (paths under `crates/codegen/`
unless noted; line numbers approximate, from the companion study
[`grok-build.md`](./grok-build.md)). effect/ai API facts marked *(verified)* reuse the
`.d.ts` citations already verified in
[`effect-ai-mapping-codex.md`](./effect-ai-mapping-codex.md) and
[`effect-ai.md`](./effect-ai.md); they were not re-derived here. Design references are
`designs/ai/alchemy-ai-design.md` (§), the canon
`designs/ai/business-processes.md` (BP §), and `packages/alchemy/src/AI/`.

**The one-sentence verdict up front**: Grok Build is the first surveyed harness whose
*verification* machinery is richer than ours on paper — the skeptic panel, evidence
packet, spec-drift detection, and stall fingerprints all land as implementations of the
**check slot we already have** (`AI.check` takes arrows, src/AI/Check.ts:29,60–69) plus
three small contract extensions (evidence fields on `CheckInput`, a typed
`origin` on kernel-injected inputs, an `InfraPaused`-shaped park) — while everything
else it does (three permission layers, compat presets, 13 hook events, the welded goal
harness, five accreted exit gates) dissolves into Layer composition we already ship.

---

## 1. The skeptic panel → check-slot composition

### What Grok Build does

When the worker calls `update_goal(completed: true)`, the harness spawns **N=3
independent skeptic subagents in parallel** (clamp 1..=5), each with a fresh context, a
private scratch dir, and the evidence packet (mapping 2). Each returns a JSON verdict
(terminal-token fallback `Refuted` / `Not Refuted`). Aggregation
(`goal_classifier.rs:1009–1045`): N=1 sole vote; N>1 **strict majority of the *cold*
skeptics**, with **skeptic 0 as a persistent gatekeeper** — it keeps its session across
verification rounds (`skeptic0_session_id`) and its decisive refute blocks Achieved even
against a cold majority. The judge prompt is default-refute:

> Your job is to **refute** that the objective has been met. **Default to
> `refuted: true` if uncertain.** … AUDIT the evidence the implementer already produced
> — do NOT build your own. … NO TEST THEATER … On a re-verification round … **the bar
> does NOT rise between rounds.**
> (`session/templates/goal_verifier_prompt.md`)

Infra failure during verification is `FailOpenAchieved` — right for an interactive TUI,
wrong for an autonomous ring (mapping 5).

### Our mapping

No new term. `AI.check(Judge)` names *who*; the panel is **physics behind the check
slot** — a check-arrow combinator that fans one judge out N times and folds verdicts.
The kernel's boundary invocation (§2.5, landed: the claim is graded before it is
believed) is unchanged; only the arrow it invokes is composite:

```ts
// src/AI/CheckPanel.ts (proposed) — a combinator, not a term kind
export interface PanelOptions {
  /** cold judges spawned fresh per verification (grok: 2) */
  readonly cold: number
  /** carry one judge's run across rounds of the SAME work item (grok: skeptic 0).
      Implemented as an ordinary delegate run keyed (judgeTerm, workItem) — the
      run-is-the-actor identity we already have (BP §1), no new session concept. */
  readonly gatekeeper?: boolean
  /** a decisive gatekeeper refute overrides a cold majority accept */
  readonly gatekeeperVeto?: boolean
}

export const panel = (judge: Agent, opts: PanelOptions): MachineCheck /* -ish */ =>
  (input: CheckInput) => Effect.gen(function* () {
    const votes = yield* Effect.forEach(
      range(opts.cold),
      () => gradeOnce(judge, input),          // fresh delegate dispatch per vote
      { concurrency: "unbounded" },
    )
    const gate = opts.gatekeeper
      ? yield* gradeSticky(judge, input)      // steer the standing (judge, workItem) run
      : undefined
    return aggregate(votes, gate, opts)       // majority-refute + veto (pure)
  })
```

Two implementation notes, both already paid for:

- **Fresh cold judges** are delegate dispatches — one ring per judge Layer, fresh run
  per work item; isolation falls out of `dispatch` (§2.8 pattern 1). **The sticky
  gatekeeper** is a *standing run* addressed by `(judgeTerm, workItem)` and re-entered
  via `steer` on each round — exactly the run-key machinery landed for machine exits
  and re-admission (BP §2 verbs). No "session" enters the check contract.
- Each judge invocation is `LanguageModel.generateObject` with a verdict schema
  *(verified: `ai/LanguageModel.d.ts:69, :564` — schema-constrained output)*, or a full
  agent turn when the judge needs tools (grok's skeptics read live files — ours resolve
  `ReadFile`/`Bash` from the judge's own Layer, run/read-only physics per §1.4).

**Aggregation is pure and lives in the combinator** — quorum rules never touch the
kernel. The kernel's four-valued verdict (§9.3) is preserved: panel-accept ⇒ `goal-met`;
panel-refute ⇒ `off-goal` with the merged gap list as feedback; judge infra failure ⇒
**`check-failed` (park with reason)** — deliberately *not* grok's `FailOpenAchieved`
(mapping 5). "The bar does not rise" becomes a sentence in the default judge policy
(kernel asset) plus a regression fixture: identical evidence across two rounds must
yield identical verdicts.

---

## 2. The evidence packet → `CheckInput` grows provenance fields

### What Grok Build does

Every skeptic receives a typed packet (`goal_classifier/evidence.rs:6–22`):

```
OBJECTIVE / CHANGES_FILE (unified diff vs the baseline commit captured at goal
creation) / CHANGED_FILES (complete, cap 300 — judges read live files) /
PLAN_FILE / PLAN_CHANGES (baseline→current plan diff) / FINAL_RESPONSE
```

Two anchors are load-bearing: the **work-product baseline** (git HEAD at `/goal`
creation — scope + honesty anchor) and the **spec baseline** (`plan.baseline.md`
frozen at creation, so `PLAN_CHANGES` catches acceptance criteria the worker quietly
weakened). A `PlanGuard` mechanically reverts plan-file edits by the strategist role —
write-scope partitioning enforced by the harness.

### Our mapping

Our landed `CheckInput` is `{ workItem, haltProse, claim }`
(src/AI/Check.ts:5–12) — the "judge needs the mandate" lesson. Grok shows the next two
fields, both derivable by the kernel, neither requiring the check author to do anything:

```ts
export interface CheckInput {
  readonly workItem: unknown
  readonly haltProse: string
  readonly claim: unknown
  /** NEW — opaque ref to the run's work product delta vs a baseline captured at
      admission (git ref, R2 object key, sandbox snapshot id). Kernel-supplied when
      the ring's Workspace/Sandbox seam can produce one; undefined otherwise. */
  readonly workProductRef?: string
  /** NEW — the spec delta: promptHash mismatch info + any fold-visible mutation of
      the run's acceptance artifacts since admission. Detects goalpost-moving. */
  readonly specDelta?: string
}
```

- **Baseline capture at admission** rides the admission ledger: the row that admits a
  work item records the baseline ref (plane 1, §3.1) — a natural companion to the
  delivery id. For Fix-shaped rings the baseline is a git ref from the sandbox Layer;
  for chat-shaped rings it is absent and the fields stay `undefined`.
- **`specDelta` needs no new mechanism**: the charter is immutable (re-rendered from the
  term, outside ContextPolicy's jurisdiction — §3.2), so the only mutable "spec" is
  externalized state (NOTES.md, plan artifacts). The check's `specDelta` is a diff over
  the fold-visible artifacts the charter names — computed by the kernel from Trace rows
  (`fold` snapshots reference their motivating events, §8.4 provenance).
- **PlanGuard maps to per-agent tool physics, which is stronger**: the Strategist-shaped
  agent's `WriteFile` Layer is scoped to its own artifact
  (`Layer.provide(WriteFileScoped("strategy.md"))`) — the edit is *impossible*, not
  reverted. Where physics can't scope (a shared checkout), grok's revert-after pattern
  is the documented fallback in the Sandbox seam notes (§3.2).

---

## 3. The stop detector + laziness classifier → graduated verification rungs

### What Grok Build does

Two cheap detectors run *before/around* the expensive panel:

- **Stop detector** (`goal_stop_detector.rs:40–88`): a pure regex panel over the final
  assistant paragraph — `unable_to_proceed`, `giving_up`, `stopping_here`,
  `check_back_later`, `ready_for_review`, `please_deflection`, `commit_push_pr` — which,
  ANDed with "todos still open", flips the continuation nudge to a bail-preface. Zero
  tokens.
- **Laziness classifier** (`acp_session_impl/laziness*.rs`): a post-turn fuzzy stall
  detector with a per-session nudge cap, grading turns that *didn't* claim completion.

### Our mapping

§2.9 already specifies the shape (deterministic occurrence → cheap fuzzy gate →
expensive judge → human, every rung positionally invoked) and the check slot already
takes machine arrows (src/AI/Check.ts:29). Grok supplies the concrete first rung and
fills our named gap ("grading quiescent non-claim boundaries", §Phase-2 item 7):

```ts
// kernel-internal machine rung, runs at EVERY boundary (claims and non-claims):
const bailDetector: MachineCheck = (input) =>
  Effect.succeed(
    matchBailProse(lastAssistantParagraph(input)) && hasOpenCommitments(input)
      ? { verdict: "off-goal", reason: "premature stop: " + matched.label }
      : { verdict: "goal-met" },  // i.e. no objection from this rung
  )
```

- At a **claim** boundary the rung composes *in front of* the charter's check: an
  off-goal from the detector short-circuits the panel (save the tokens; the nag carries
  the matched label as feedback).
- At a **quiescent** boundary (turn ended, no `resolve`, no `give_up`) the rung is the
  *whole* grading — matching grok's bail-preface behavior: the boundary nag we already
  ship (halt-as-tool's "neither resolve nor give_up" nag, §2.5) gets a *reason-bearing*
  variant. The nag stops being generic prose and starts quoting the detected deflection
  ("you said 'ready for review' but the run's halt condition is unmet").
- The **laziness-classifier** rung (fuzzy, capped) is a cheap-model `generateObject`
  judge invoked only when the machine rung is inconclusive N boundaries in a row —
  Layer-composable on the same slot, budgeted like any agent (§8.4 "judging itself has
  a budget").

The pattern list itself (stopping-here / ready-for-review / please-run / check-back
deflections) ports nearly verbatim as a kernel asset — versioned, `promptHash`-adjacent
(it shapes model-visible nag text), with grok's list as the seed corpus.

---

## 4. Stall fingerprints → the `stall` ceiling's detector

### What Grok Build does

Stagnation is **fingerprint equality over the judge's reported gaps**: each NotAchieved
verdict carries a gap set; the tracker hashes it; the same fingerprint appearing twice
(`GOAL_CLASSIFIER_STALL_THRESHOLD = 2`) pauses the goal as `NoProgressPaused`
(`goal_tracker.rs`). Separately, three consecutive non-success *turns* trigger
`BackOffPaused`, and a `blocked_reason` streak (plus a contradiction/unverifiable-only
gap set) yields `Blocked`.

### Our mapping

`AI.budget({ stall })` promises the no-progress ceiling; §1.2.2 leaves *detection* as
kernel policy. Adopt grok's mechanism as that policy — it is strictly better than
diffing folds:

- The check's `off-goal` reason (already the next iteration's first input, landed §2.5)
  is *also* hashed into the ring's boundary state: `stallFingerprint =
  hash(normalize(reason))`.
- Identical fingerprint `stall` times ⇒ `BudgetExceeded { limit: "stall", used:
  fingerprintCount, resumeHint: reason }` (src/AI/Errors.ts:17–28 already carries the
  fields).
- This couples stagnation to the verifier — who already articulates *what is missing* —
  instead of to fold deltas, which churn cosmetically (timestamps, orderings) and go
  quiet exactly when the model repeats itself.

Grok's `Blocked` semantics reinforce the `Refused` bar we adopted from Codex
(src/AI/Errors.ts:42–49): a `blocked_reason` claim ratifies into `Refused` only after a
streak (`observed` counts consecutive iterations) — and grok adds the *content* rule
worth stealing: a gap set consisting **only** of contradiction/unverifiable items is
itself Blocked-evidence (the goal is malformed, not merely unfinished). That rule slots
into the ratification policy as a fast path.

---

## 5. The pause taxonomy → parks, and the `InfraPaused` gap

### What Grok Build does

Eight statuses (`goal_tracker.rs:64–87`), all but `Complete` resumable with state
retained: `Active | UserPaused | BackOffPaused | NoProgressPaused | InfraPaused |
Blocked | BudgetLimited | Complete`. Budget exhaustion is a checkpoint, not a tombstone.
On restart, `Active → UserPaused` (subagents don't survive) and in-flight phases reset.
Verifier *infra* failure is `FailOpenAchieved` — accept rather than strand the
interactive user.

### Our mapping

| Grok status | Ours | Status |
|---|---|---|
| `BudgetLimited` | `BudgetExceeded` parks resumably with `resumeHint` (§9.3) | landed (typed) |
| `NoProgressPaused` | `BudgetExceeded { limit: "stall" }` (mapping 4) | detector proposed |
| `Blocked` | `Refused` claimed-then-ratified | landed; ratification streak not yet |
| `BackOffPaused` | kernel default guard for budget-less loops (defect today) | partial — should park, not die |
| `UserPaused` | `interrupt` (settles as typed interruption; re-dispatch resumes off the fold) | landed |
| `InfraPaused` | **gap** — no typed "the harness failed, not the work" park | proposed |
| `FailOpenAchieved` | **rejected** — check-failed parks, never accepts (§2.5) | doctrine holds |

The `InfraPaused` gap is real: today a worker-substrate failure (sandbox died, provider
outage past retries) surfaces as a `KernelError` defect or gets misfiled as budget
noise. The park taxonomy should distinguish it — same shape as check-failed (park with
reason, deliver the fold, await explicit resume), applied to the worker's substrate
rather than the judge. On the Ring DO this is one more admission-ledger attempt-marker
state, not a new plane.

`FailOpenAchieved` is the one grok choice we explicitly do not adopt: it is correct for
a TUI whose user is watching and wrong for an autonomous ring (a broken judge that
accepts is the worst failure mode — §6 "unvalidated graders enforce the wrong standard,
fast"). The general lesson stands though: **failure polarity is a per-role, per-ring
declaration** — grok hardcodes planner fail-closed / strategist fail-open / verifier
fail-open; ours is a Layer choice per ring, which is the same expressiveness without
the hardcoding.

---

## 6. `update_goal` + continuation → halt-as-tool + nags (validation)

Grok's done-ness is exactly a tool call — `update_goal { completed?, message?,
blocked_reason? }` (`xai-grok-tools/.../update_goal/mod.rs:29–50`) — graded by the
panel before it is believed; the harness never auto-completes from prose. Continuation
is a synthetic injected user message with a fixed sentinel (`Goal NOT complete —
continue working. Next step:`) mined from the plan's first unchecked item.

This is our landed §2.5 shape, third independent convergence (Flue's result tools,
Codex's `update_goal`, now grok): **halt-as-tool** (`resolve` validated strictly in the
kernel handler, `give_up` → typed `Refused` claim) and the boundary nag. Two grok
details worth folding in:

- `blocked_reason` on the *same* tool as completion — one protocol surface for both
  exits, not a second tool. Ours already matches (`resolve`/`give_up` are compiled
  together); keep it that way when the ratification streak lands.
- The continuation prose carries **the next concrete step** (mined from the plan
  artifact) and optionally a one-shot strategist recommendation. Our nag is generic
  today; when `AI.fold` lands, the nag should be able to quote the fold's
  next-step slot — a kernel-asset template parameter, not new machinery.

---

## 7. Three-door steering → `send`/`steer`/`interrupt`, plus queue re-classing

### What Grok Build does

Mid-run input has three typed doors (`acp_session_impl/prompt_queue.rs`,
`interjection.rs`): **queue** (FIFO with wire metadata; reorder/edit/remove ops),
**interjection** (buffered, drained at loop-top and again before declaring Completed;
injected as a `UserItem` tagged `SyntheticReason::Interjection`), and **send-now**
(cancel the running turn, preserve the queue, auto-selected when the turn blocks in an
interruptible wait). A queued prompt can be **atomically promoted** into an interjection
(`handle_interject_queued_prompt`) — dequeue + steer as one move, so it can't both
steer and later run as its own turn. Stranded interjections (arrived idle) become
front-of-queue prompts.

### Our mapping

The doors are our verbs (BP §1): queue = `send` (admission mailbox), interjection =
`steer(runKey, msg)` promoted at the boundary (deliberately coarser than grok's
mid-batch drains — §2.1), send-now = `interrupt` + re-dispatch. Stranded-interjection
fallback = our parked-steer semantics (a steer landing on an idle run parks and enters
the next run — landed, §2.8a). Two additions to take:

1. **Admission re-classing.** The promotion move — *this queued work item becomes a
   steer of the active run* — should be a single transactional ledger operation keyed
   by delivery id (plane 1): flip the row's kind from `work-item` to `steer(runKey)`
   iff still undelivered. The org front door wants it ("fold this new report into the
   running fix instead of opening a second run"), and doing it as delete+insert races
   the drain loop. One CAS on the DO; a mutex in the memory ledger.
2. **Typed `origin` on kernel-injected inputs.** Grok tags every synthetic user message
   with `SyntheticReason` (`Interjection | AutoContinue | AutoRecovery |
   SubagentCompleted | GoalClassifierNudge | …`) — model-visible *and* machine-auditable.
   Our Trace events carry `cause`, but the injected *input* payload doesn't carry its
   kind. Add `origin: "steer" | "nag" | "check-feedback" | "completion-steer" |
   "recovery"` to the durable payload of kernel-synthesized inputs (and render them
   distinctly), so autoresearch can cluster nag-driven vs input-driven work without
   prose-sniffing. Cheap now; retrofit means re-parsing prose forever.

---

## 8. Subagents: auto-wake, usage roll-up, depth cap, forked context

### What Grok Build does

The `task` tool spawns a full child session (`MAX_SUBAGENT_DEPTH = 1` — children cannot
spawn); background completion injects a synthetic prompt tagged
`SyntheticReason::SubagentCompleted`; child usage rolls into parent ledgers with an
explicit incomplete-attribution path (`RecordSubagentUsage`); Ctrl+C cancels children
but **send-now deliberately does not** (the parent turn dies, children keep running);
crash replay reconciles unpaired `subagent_spawned` events into synthetic
`SubagentFinished { status: "cancelled", error: "interrupted by process restart" }`
(`session/storage/mod.rs:1017–1056`). Forked context is normalized: ≤3 verbatim turns,
else summarize-early + last-3 verbatim, task prompt last
(`xai-grok-subagent-resolution/src/context.rs:37–110`). A failed per-role model
override retries once inheriting the parent's model (fail-open spawn).

### Our mapping

Four independent convergences with landed machinery, one policy to copy, one topology
note:

- **Completion-as-steer**: `SubagentCompleted` auto-wake = our §2.8a completion steers
  (landed, live-tested — background dispatch settles as a steer, parking if the host is
  idle). Convergence count across the survey is now four (Mastra amendment, Eve parks,
  Codex inter-agent messages, grok auto-wake).
- **Crash reconcile** = our pairing invariant applied to child lifecycles: the ledger's
  child registry (§2.8b) settles orphaned children as typed interruptions on recovery.
  Grok's synthetic `SubagentFinished` is the same repair, hand-rolled — a conformance
  fixture for our `Recovered` path.
- **Usage roll-up with incomplete-attribution** = budget **leases** (§2.8, Eve conflict
  #2): reserve at fork, reconcile on settlement; grok's explicit "usage arrived but the
  prompt it belonged to is gone" path is the reconciliation edge case our ledger
  must also record (attribute to the ring when the run key is gone, never drop).
- **Depth cap**: grok's constant is our Layer-graph structure — a delegate the charter
  doesn't interpolate can't be spawned; recursion is denied by construction, not by a
  checked constant (§gap ledger, dissolved).
- **Copy the fail-open spawn retry**: a delegation whose specific model/physics Layer
  fails at spawn should fall back to the ring default with a durable Trace note
  (`origin: "recovery"`), not fail the parent's turn. One `Effect.catchTag` in the
  delegation-tool handler.
- **Forked-context normalization** is a third memory topology datapoint (alongside
  Codex `LastNTurns` forks and summary-return): *bounded-verbatim-tail + summarized
  head, mandate last*. Our fork semantics pass a work item (deliberately); when
  fork-of-trace lands (§9.3 deferred), grok's shape — cap the verbatim suffix, fold the
  prefix — is the sane default rendering of a Trace-prefix reference.

---

## 9. Repair-at-write-boundaries vs repair-on-read (we hold)

Grok repairs dangling tool calls at **write boundaries** — actor startup,
`push_user_message`, request build, an explicit `RepairHistory` command gated by a
turn-active flag (`xai-chat-state/src/actor/mod.rs:188–206, 243–268`;
`sampling-types/conversation.rs:2767–2824`) — with typed reasons
(`UserCancelled | HarnessHalted{class}`), synthetic cancelled results for interrupted
waits, and a dedup pass for a real result racing a synthetic one. Plus three sibling
compensators: torn-JSONL-tail healing, subagent reconcile (mapping 8), and event-id
re-seeding after replay.

Our `Pairing.ts` is **repair-on-read** (landed: pure, idempotent, deterministic,
trim-composing — §Phase-2 item 2), which subsumes the write-boundary discipline: any
materialization is well-paired regardless of which writer forgot. Nothing to adopt
structurally; what grok contributes is **test vectors** — each compensator is a
conformance fixture our resume+repair floor must pass generically:

1. crash mid-tool-batch ⇒ synthetic failures, model-visible, cache-stable;
2. real result racing a synthetic cancel ⇒ exactly one survives (dedup — ours: the
   repair pass drops the orphan *result*, keyed on call id);
3. child spawned, never settled, process restarted ⇒ typed interruption with retained
   child Trace;
4. replay after recovery ⇒ id monotonicity (ours by construction: deterministic ids
   derive from position, `src/AI/Ids.ts`).

The turn-active guard on `RepairHistory` (refuse mutation while a turn runs, serialized
through the actor) is the same property our boundary gets free from the serial ring:
repair composes into the `fold → repair → render` pipeline, never concurrent with it.

---

## 10. The session store: two truths, cursor replay, compaction provenance

### What Grok Build does

Per-session directory: **`updates.jsonl`** (append-only log of every ACP update — UI
truth, cursor-replayable), **`chat_history.jsonl`** (the model conversation —
*replaced wholesale* on compaction), mutable `summary.json`, and ~10 side files.
Resume = `load_light` (snapshot the chat history for the model) + stream-replay
`updates.jsonl` to clients with cursor support; live notifications are buffered during
an in-flight `session/load` so replay never interleaves with live; the global event-id
counter re-seeds from the max persisted id. Compaction persists **the exact compacted
history** (`compaction_checkpoints/{id}.json`) and **the exact summarizer
request+response** (`compaction_requests/{id}.json`) — full drill-back and offline A/B.
There is **no write-ahead ordering**: the persistence actor races the turn; durability
of already-observed effects depends on flush timing.

### Our mapping

- **The two-file split is the anti-pattern §2.7 forbids** (a second transcript by
  construction), and grok's compaction checkpoints are the compensating machinery: once
  the model history is a *replaceable materialization*, you must separately archive
  every pre-replacement state to keep provenance. Our Trace-is-truth + derived-`Prompt`
  design needs no archive — the fold never destroys rows. Held, not changed.
- **Steal the compaction artifact anyway**: our `ContextCompacted` durable event
  (adopted from Codex, window-chain fields) should carry the **summarizer's exact
  request and response** in its payload (or an R2 ref when oversized). Grok proves the
  operational value: folds become offline-auditable and A/B-able against recorded
  inputs — precisely the autoresearch food §8.4's provenance requirement wants, and it
  costs one payload field now vs an archive subsystem later.
- **The serving tier is convergent**: cursor replay over an append-only update log,
  live-buffering during replay, monotonic ids re-seeded after load — that is our
  trace-endpoint reconnect design (§2.10: disconnects kill the window, never the run;
  reconnect is replay-from-cursor). Grok's `load_light` split (snapshot for the model,
  replay for the client) mirrors our "the Prompt is derived (fold → repair → render);
  the transcript view is a projection of Trace facts."
- **No-write-ahead is the floor we refuse**: §2.7's stash-point ordering (journal
  `CallModel` before the wire, `CallTool` before execution, commit at command
  boundaries) is normative for every kernel Layer. Grok ships flush barriers only at
  selected points (user-message persist ack) — evidence that retrofitting ordering onto
  a concurrent persistence actor is hard enough that they didn't; we get it free from
  the DO output gate and the memory kernel's synchronous transaction.

---

## 11. Smaller mappings, tabulated

| Grok Build mechanism | Evidence | Our mapping |
|---|---|---|
| Prompt templates reference tools *by kind* (`${{ tools.by_kind.read }}`), conditional sections drop with absent tools | `xai-grok-agent/templates/prompt.md:19,22–28` | The untyped shadow of interpolation-as-dependency (§0 claim 1). Our renderer resolves `${Tool}` refs with compile-checked `Req`; grok validates the *need* (prose must track the toolkit mechanically) without the types |
| XOR-obfuscated prompts, `Zeroizing` decrypt, staleness tests | `prompt/template.rs:1–28,68–93` | Rejected as theater; ours is the opposite bet — `promptHash` content-addressing, prompts as reviewed diffs (§1.6). The staleness *test* pattern (encrypted bytes must match source) is the only piece worth noting: our `kernelAssetsHash` snapshot tests are the analogous drift fence |
| Post-compaction system prompt shrinks to a 2-line constant | `prompt/template.rs:55–56` | Not applicable by construction: our system region is re-rendered from the immutable term and never enters the compactable region (§3.2) — no "compact identity" variant needed |
| Approvals-as-amendments: `AllowAlwaysBashCommand/Domain/McpTool/Server`, `AllowEditsForSession`, `RejectAlwaysBashCommand` | `workspace/permission/prompter.rs:285–308` | Validates Ask answers as verdict+amendment (§9.3, Ask landed; `PolicyAmended` fold state not yet). Extend the proposed `PolicyAmendment` union with `domain` and `mcp` scopes — grok and Codex both grew them, we should ship them in v1 of the amendment schema |
| Denial = failed tool result + sibling-cancel | `acp_session_impl/tool_calls.rs:1147–1175, 2567–2584` | Landed doctrine (pairing invariant, model-visible denials). Sibling-cancellation of a batch after one rejection is a scheduler rule for Stage-B's RW-lock scheduler (not yet built): a write-lock denial poisons the rest of the batch with typed cancelled results |
| MCP meta-tools `search_tool`/`use_tool`; catalogs out of the schema | user-guide `07-mcp-servers.md`; `implementations/{search_tool,use_tool}/` | A `ToolMode`-adjacent presentation policy (BP §4: `CompiledTool[]`/`ToolMode` seams, P1): a capability package may compile to discover+invoke instead of N schema entries. Same shape as Skills' dormant index — one decision per term, kernel-seam owned |
| Skills: budgeted index + mid-session discovery reminder | `prompt/skills.rs:49–58`; `skill_discovery_tracker/mod.rs:225–228` | Skills term (BP §4) already adopts index+activation; the *mid-session discovery* (announce SKILL.md files near tool-touched paths) is a nice ContextPolicy-adjacent enrichment — harness-private, rides tool results like LSP diagnostics, no term change |
| LSP diagnostics appended to edit results as `<system-reminder>` | `reminders/lsp_diagnostics.rs` | The `ToolInterceptor` seam's positive direction (§3.2): interceptors may *enrich* results, not just block/rewrite. Environment feedback rides the pairing-invariant surface — no new channel |
| Leader daemon: one runtime, many clients, per-client caps | `leader/mod.rs:1–33`, `protocol.rs:107–117` | The serving tier (§2.10) already separates the run from its windows; per-client capability injection maps to per-surface Layer provision on the API host, not on rings |
| Sandbox fail-open + `sandbox_auto` bash approval | `xai-grok-sandbox/src/lib.rs:147–198` | Rejected: our Sandbox seam is fail-closed (a ring whose sandbox Layer fails to acquire parks as InfraPaused — mapping 5), and approval policy never keys on sandbox *presence* (the Judge's COW overlay is capability physics, not an approval bypass) |
| Doom-loop detection (sampler + tool dispatch) | `xai-grok-{sampler,sampling-types}/src/doom_loop*` | Kernel-policy stagnation detection *below* the check (per-turn repetition, distinct from mapping 4's cross-iteration stall) — a Stage-B guard: N identical consecutive tool calls ⇒ synthesize a failed result with a break-the-loop nudge |
| Memory: idle flush + dream consolidation | `run_loop.rs:155–178`; `xai-grok-memory` | Mastra-OM-shaped background fold on idle cadence — a `ContextPolicy`/fold-Layer choice (§3.2 Memory Layers), validating fold-on-idle as a trigger alongside fold-on-boundary. No kernel change |

---

## 12. The gap ledger

### What Grok Build has that effect/ai + our design cannot yet express

1. **A stateful judge across verification rounds.** The gatekeeper skeptic carries its
   session between rounds of one goal. Our checks are stateless arrow invocations; the
   mapping (standing run keyed `(judgeTerm, workItem)`, re-entered by `steer`) works but
   is *convention*, not contract — nothing types "this check arrow may hold per-run
   state". Acceptable; document the pattern in the check-combinator notes.
2. **Work-product baselines need a Workspace capability.** `CheckInput.workProductRef`
   (mapping 2) presumes the ring's sandbox/workspace Layer can snapshot-and-diff. Our
   Sandbox seam has optional `snapshot` (§9.3); the *diff-against-admission-baseline*
   contract is new surface for Phase 3.
3. **Per-result flush acks.** Grok can ack "this user message is durably persisted"
   before proceeding (`FlushAndAck`). Our stash points are command-boundary
   transactions — coarser; a front door wanting a durable-admission receipt gets it
   from the ledger row, which covers the org case, but there is no mid-turn ack surface.
4. **In-message model-visible origin tags** exist in grok as first-class message fields;
   effect/ai `Prompt` messages carry `options` metadata per message *(verified:
   `ai/Prompt.d.ts:763–773`)* — our `origin` (mapping 7) rides Trace payloads and
   render prefixes, not provider-visible message fields. Fine, but the render must do
   the work the field would.

### What our typed Layer graph dissolves that Grok Build needs runtime machinery for

1. **Three permission layers + a rule DSL** (~15k LOC engine). Capability-by-omission +
   per-agent tool physics + the Ask protocol replace mode triads and pattern DSLs with
   compile-time absence and Layer choice (§1.4, §9.3). The amendment store is the one
   runtime residue, and it is fold-visible state, not an engine.
2. **The welded goal harness** (~18k LOC, non-reusable outside `/goal`). Planner/
   strategist/summarizer/panel/statuses/continuation are our Process control
   expressions + check-slot Layers — each independently reusable, swappable per ring,
   and absent unless the charter names them. The strongest validation yet of §0
   claim 4: xAI built our Process semantics exactly once, non-compositionally.
3. **Five accreted exit gates** (TodoGate, laziness, completion requirement, goal
   continuation, structured output) with five cap configs — one boundary, one check
   slot, graduated rungs (mapping 3), each a Layer on the same position.
4. **Compat presets and vendored tool ports.** Codex/OpenCode tool namespaces + preset
   remapping exist to be a drop-in replacement; our tool identity is the term tag and
   physics is the Layer — "presets" are provide-lists (BP §5 environments).
5. **13 hook events, subprocess JSON protocol, fail-open dispatch.** PreToolUse-blocks
   = `ToolInterceptor`; Stop/SubagentStop = check verdicts and completion steers;
   Pre/PostCompact = inside `ContextPolicy`; SessionStart/End = Layer lifecycle. The
   closed hook vocabulary growing one event per need is §9.5's rejected shape, third
   sighting.
6. **Subagent depth constants and role-override plumbing** — Layer-graph structure and
   per-turn `CallModel` data (§2.4) respectively.

---

## Implementation order (deltas into the Phase-2 build order)

Ordered by dependency; each lands independently against the memory kernel:

1. **`CheckInput` evidence fields** (mapping 2): `workProductRef?`/`specDelta?` on the
   contract now (pure type change; kernel supplies `undefined` until the Workspace seam
   exists). Cheap now, painful retrofit — the check-prompt renderer must know the
   fields exist from v1.
2. **Bail-detector `MachineCheck` + reason-bearing nags** (mapping 3): kernel asset
   pattern list + the quiescent-boundary rung; wires into the existing boundary
   grading. Fixture: a turn ending "ready for review" with an unmet halt must re-loop
   with the quoted deflection.
3. **Stall fingerprints** (mapping 4): hash off-goal reasons into boundary state;
   `BudgetExceeded{limit:"stall"}` on repeat. Property test: cosmetic reason variance
   (whitespace, ordering) must not defeat normalization.
4. **Typed `origin` on kernel-injected inputs** (mapping 7): payload field + render
   prefix; migrate the existing nag/steer/completion-steer emitters.
5. **`Refused` ratification streak + malformed-goal fast path** (mapping 4): N
   consecutive `give_up` observations, or a contradiction-only gap set, ratify; already
   scheduled (§Phase-2 item 7 "not yet"), now with grok's content rule.
6. **`CheckPanel` combinator** (mapping 1): cold-N + sticky gatekeeper + quorum fold;
   ships as a Layer example beside `ApproveGuardian` (both are "judgment as
   composition" demos). Needs delegation + steer only — both landed.
7. **Admission re-classing** (mapping 7): queued-item → steer as one ledger CAS; memory
   ledger first, DO row op in Phase 3.
8. **`ContextCompacted` payload carries the summarizer request/response** (mapping 10):
   one field on an already-adopted event.
9. **`InfraPaused` park** (mapping 5): typed substrate-failure park distinct from
   check-failed and budget; folds into the ledger attempt-marker states in Phase 3.
10. **Conformance fixtures from grok's compensators** (mapping 9): the four repair
    vectors join the resume+repair floor suite that every kernel Layer must pass.
