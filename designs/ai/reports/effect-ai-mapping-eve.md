# Eve's durable-agent machinery on effect/ai v4 + Durable Objects

Design-research report: how Eve's park/resume hooks, snapshot-in-step-result,
durable/rebuilt split, budget leases, task-vs-conversation modes, and
channel-paired HITL rendering would be implemented inside the Alchemy AI
kernel's Cloudflare harness, using **only verified APIs** from
`effect/unstable/ai` (`node_modules/effect/dist/unstable/ai/*.d.ts`, checked
against `.js` where behavior mattered) and the Alchemy Cloudflare DO surface
(`packages/alchemy/src/Cloudflare/Workers/`).

Sources: `designs/ai/alchemy-ai-design.md` (§2.2/§2.4/§2.5/§3.1/§3.2/§9.3),
`packages/alchemy/src/AI/*.ts`, the Ring DO mock
(`test/AI/fixtures/org/cloudflare/kernel.ts`), `designs/ai/reports/eve.md`,
and the vendored Eve source (`.vendor/eve/packages/eve/src/`).

---

## 0. Verified API inventory

Everything used in the sketches below, with citations. Nothing else from
effect/ai is assumed.

| API | Citation | Note |
|---|---|---|
| `Chat.Service.history: Ref.Ref<Prompt.Prompt>` | `Chat.d.ts:89` | in-memory Ref, not transactional |
| `Chat.Service.export: Effect<unknown, AiError>` / `exportJson` | `Chat.d.ts:115,143` | structured snapshot of history |
| `Chat.fromExport(data): Effect<Service, SchemaError>` / `fromJson` / `fromPrompt(RawInput)` / `empty` | `Chat.d.ts:412,452,363,300` | restore path |
| `Chat.Persistence.Service.get/getOrCreate`, `Persisted.save`, `makePersisted({storeId})`, `layerPersisted` | `Chat.d.ts:498-560,579` | requires `BackingPersistence` |
| `LanguageModel.GenerateTextOptions`: `prompt: Prompt.RawInput`, `toolkit`, `toolChoice`, `concurrency`, `disableToolCallResolution` | `LanguageModel.d.ts:131-176` | `disableToolCallResolution` is the seam for per-command journaling |
| `LanguageModel.generateText` / `streamText` (service + module-level) | `LanguageModel.d.ts:53-85,518-604` | **one provider call per invocation; no internal loop** |
| `GenerateTextResponse`: `.text`, `.toolCalls`, `.toolResults`, `.finishReason`, `.usage` | `LanguageModel.d.ts:243-274` | |
| `LanguageModel.make({generateText, streamText})`, `ProviderOptions` (incl. `incrementalPrompt`, `previousResponseId`) | `LanguageModel.d.ts:390-492` | provider adapter seam |
| `Tool.dynamic(name, {description?, parameters?: Schema\|JsonSchema, success?, failure?, failureMode?, needsApproval?})` | `Tool.d.ts:905-1030` | runtime schemas — exactly what terms are |
| `Tool.NeedsApproval<Params>` = `boolean \| (params, {toolCallId, messages}) => boolean \| Effect<boolean>` | `Tool.d.ts:104-133` | |
| `Toolkit.make(...tools)`, `Toolkit.WithHandler.handle(name, params)`, `HandlerContext.preliminary` | `Toolkit.d.ts:212,133-160,72-82` | `handle` = manual tool execution for `disableToolCallResolution` |
| `Response.StreamPart<Tools>` (deltas, tool-params-*, tool-call, tool-result, `ToolApprovalRequestPart`, `FinishPart`, `ErrorPart`) | `Response.d.ts:109-116` | |
| `Response.ToolApprovalRequestPart {approvalId, toolCallId}` | `Response.d.ts:1164-1197` | emitted by the framework when `needsApproval` gates a call (`LanguageModel.js:699-711`) |
| `Response.FinishReason` incl. `"pause"` | `Response.d.ts:1632-1654` | |
| `Response.Usage`: `inputTokens {uncached,total,cacheRead,cacheWrite}`, `outputTokens {total,text,reasoning}` — all `number \| undefined` | `Response.d.ts:1655-1712` | the AI-SDK-v4-shaped usage §2.4 requires |
| `Prompt.Prompt` (`Schema.Codec<Prompt, PromptEncoded>`), `PromptEncoded`, `RawInput`, `empty`, `make`, `fromMessages`, `concat` | `Prompt.d.ts:1278-1330,1346,1377,1401,1466` | the transcript codec — our snapshot serialization |
| `Prompt.ToolApprovalResponsePart {approvalId, approved, reason?}`; `ToolMessagePart = ToolResultPart \| ToolApprovalResponsePart` | `Prompt.d.ts:599-622,1194` | the **answer** wire shape |
| Per-message/part `options: ProviderOptions` (open `Record<string, Json>`) | `Prompt.d.ts:16-24,64-100` | the only hook for cache breakpoints |
| Approval pre-resolution: `collectToolApprovals` → `executeApprovedToolCalls` / `createDenialResults` → `stripResolvedApprovals` before the provider call | `LanguageModel.js:385-478,858-960` | **verified in .js**: approvals answered in the prompt are resolved on the *next* model call |
| DO storage: `state.storage.get/put/delete/list`, `storage.transaction`, `getAlarm/setAlarm/deleteAlarm`, `alarm` handler | `Cloudflare/Workers/DurableObjectStorage.ts:107-267`, `DurableObject.ts:89` | |
| `Cloudflare.AI.DurableObjectChatPersistence: Layer<BackingPersistence>` over DO storage | `Cloudflare/Workers/DurableObjectChatPersistence.ts` | exists today; see gap G2 |

Eve citations used throughout are from `.vendor/eve/packages/eve/src/` and
are given inline.

---

## 1. One-model-call-per-durable-step

**Eve.** `turnStep` is one `"use step"` (`execution/workflow-steps.ts:111-112`)
whose body runs the AI SDK `ToolLoopAgent` with `stopWhen: isStepCount(1)`
(`harness/tool-loop.ts:851`): one workflow step = one model call **plus all
the tool executions it requested**, and the step's return value
(`DurableStepResult`, `workflow-steps.ts:80-104`) embeds the entire session
snapshot. Crash mid-tool re-runs the model call and every sibling tool —
their documented coarseness (eve.md §2.5, "What's weak" #5).

**The effect/ai fit.** We don't need the `stopWhen` trick at all:
`LanguageModel.generateText`/`streamText` performs **exactly one provider
call per invocation** — it resolves the returned tool calls once through the
toolkit and returns; it never loops back to the model (verified in
`LanguageModel.js:516` — `resolveToolCalls` feeds results into the *returned
content*, not into a second request). Eve had to clamp a loop; effect/ai
hands us the unclamped primitive. The agent loop is ours to write, which is
what §2.4's step machine already assumes.

**Which rung one `streamText` call occupies.** The §3.2 ladder places it at
the **turn tier (doFiber)** — and we go one grain *finer* than Eve, fixing
their coarseness:

- One `CallModel` command = one `streamText` invocation with
  `disableToolCallResolution: true` (`LanguageModel.d.ts:164-172`). The
  kernel receives the response's tool-call parts as `Feedback` and emits
  `CallTool` commands itself, executing each via `toolkit.handle(name,
  params)` (`Toolkit.d.ts:151-160`). Each `CallTool` is journaled *before*
  execution and its result journaled after — so a crash mid-tool re-runs
  **that tool at most** (per Resume policy), never the model call and never
  sibling tools. This is the doFiber row's write-ahead journal, and it is
  where the ToolInterceptor seam and the pairing invariant live.
- At the **iteration tier (Workflow)**, the analogue of Eve's `turnStep` is
  one Workflow step per *iteration* (several model turns), and — exactly
  Eve's discipline — **the persisted step result is the folded state**, not
  a side write. Eve validates the mechanism; our unit is the fold, not the
  raw history (eve.md §4.1).

**What is persisted at a stash point.** Not Eve's whole-history snapshot.
Two writes, one transaction (`storage.transaction`,
`DurableObjectStorage.ts:252-258`):

1. **Trace append** (plane 2): the durable events of the epoch —
   `ModelRequested`/`ModelCompleted` (with `Response.Usage`),
   `ToolRequested`/`ToolCompleted`/`ToolFailed` — deterministic ids from
   `(term, session, turn, callId/ordinal)`. Deltas (`text-delta`,
   `tool-params-delta`) are live-only, never written.
2. **Stash** (plane 2): the serializable `StepState` checkpoint:

```ts
// the turn-tier checkpoint row (versioned envelope, see §7)
interface StepStash {
  readonly v: 1
  readonly promptHash: string            // fossil detection, §2 below
  readonly seq: number                   // trace cursor this stash is consistent with
  readonly phase: "model" | "tools" | "boundary"
  readonly budget: BudgetLedger          // per-command decrements, §4
  /** The transcript, encoded with effect/ai's own codec —
      Schema.encodeEffect(Prompt.Prompt) / chat.export (Chat.d.ts:115).
      EXCLUDES the system message (re-rendered from the term, §2). */
  readonly transcript: Prompt.PromptEncoded
  readonly pendingAsk?: PendingAskRow    // §3
}
```

**Ring DO turn execution with stash points:**

```ts
// inside the Ring DO (single-threaded; plane-1 reducer already admitted the work item)
const turn = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState
  // [hydrate] — §2: fold snapshot + current term render
  const { chatPrompt, carried, budget } = yield* hydrate(foldRow, term)

  // ---- stash point A: journal CallModel before the wire call
  yield* journal({ kind: "CallModel", turn, ordinal: 0 })            // plane 2, txn
  const response = yield* LanguageModel.generateText({
    prompt: Prompt.concat(renderedSystem, chatPrompt),               // Prompt.d.ts:1466
    toolkit,                                                          // Stage-A linked Toolkit.WithHandler
    disableToolCallResolution: true,                                  // LanguageModel.d.ts:164
  })
  // ---- stash point B: ModelCompleted + usage decrement + partial stash, one txn
  yield* commit([modelCompleted(response.usage)], stash({ phase: "tools", ... }))

  for (const call of response.toolCalls) {                            // LanguageModel.d.ts:261
    yield* journal({ kind: "CallTool", callId: call.id, name: call.name })
    const gated = yield* interceptor.apply(call)                      // may synthesize a block-result
    const result = gated ?? (yield* runHandle(toolkit, call))         // Toolkit.d.ts:151
    // ---- stash point C (per tool): ToolCompleted + budget, one txn
    yield* commit([toolCompleted(call.id, result)], stash({ phase: "tools", ... }))
  }
  // ---- stash point D (turn boundary): fold + IterationFolded + stash, one txn
  const carried2 = yield* fold(carried, traceSince(seq))
  yield* commit([iterationFolded(carried2)], stash({ phase: "boundary", transcript, ... }))
})
```

Recovery classification (§9.3 `Recovered`, Flue's taxonomy): stash at A →
re-dispatch the model at most once; stash at B/C with journaled-but-
unanswered `CallTool` → repair as typed interrupted results (pairing
invariant); stash at D → clean boundary, run the §2.5 check/halt decision.

---

## 2. The durable/rebuilt split — `hydrate(fold, term)`

**Eve.** `projectToDurableSession` (`execution/session.ts:190-249`) persists
history + authored state + limits + sandbox refs and **drops** model
reference, tool schemas, and compaction thresholds;
`hydrateDurableSession` (`session.ts:256-317`) rebuilds those from the
current deployment's `turnAgent` every turn, and
`refreshSessionFromTurnAgent` (`session.ts:129-158`) replaces the system
prompt before each model step (`durable-session-store.ts:66-72`: persisted
`agent.system` is only "the last applied prompt snapshot"). Pinned driver /
latest child-workflow (`durable-session-store.ts:10-16`,
`startWorkflowPreferLatest` in `workflow-steps.ts:574-596`) is their
deployment-skew answer.

**Ours, sharpened.** The fold snapshot persists **only what is not
derivable from the term**; everything derivable is re-rendered per
iteration and stamped with the fresh `promptHash`:

| In the fold snapshot (durable) | Re-derived from the term each iteration (rebuilt) |
|---|---|
| carried fold state (the fold agent's output) | rendered system prompt (the charter render) |
| transcript as `Prompt.PromptEncoded` — **user/assistant/tool messages only, no system message** | `Toolkit` — `Tool.dynamic` per tool ref (`Tool.d.ts:905`), delegation tools from interpolated Agents/Loops, synthetic `resolve`/`give_up` |
| budget ledger (spent per axis, outstanding leases) | model (the `LanguageModel` Layer — per-term physics) |
| pending Ask rows, approved-policy amendments (fold-visible ring state) | control parameters (halt/check/fold/budget config from refs) |
| `promptHash` **the snapshot was created under** | Ask-layer channel pairing (§6) |
| `seq` trace cursor, `v` envelope version | tool `needsApproval` policies, ToolInterceptor config |

Unlike Eve we do not even persist a "last applied prompt snapshot": §3.2's
doctrine is that the rendered term is re-supplied on every model call and
sits **outside** the compactable region, so guardrails cannot be compacted
away and there is nothing to refresh.

```ts
// hydrate: fold snapshot + current term → live turn inputs
const hydrate = Effect.fn(function* (snap: FoldRow, term: InterpretableTerm) {
  const migrated = yield* migrateFoldRow(snap)              // §7 — read-path migration

  // Stage A (re)link against the CURRENT deployment: render + toolkit + model
  const { renderedSystem, promptHash, toolkit } = yield* link(term)

  // checkpoint-fossil check (§9.3): recovered state carries the promptHash
  // it was created under; a mismatch with the deployed term routes to the
  // Resume policy — never blind Continue.
  if (migrated.promptHash !== promptHash) {
    const verdict = yield* resume({ kind: "PromptDrift", was: migrated.promptHash, now: promptHash })
    // default policy: Retry-with-fresh-render — keep transcript + carried
    // state, drop any half-turn journal, restart the iteration body.
    if (verdict === "Terminal") return yield* Effect.fail(new KernelError({ ... }))
  }

  // restore the transcript with effect/ai's own codec — two equivalent doors:
  //   Chat.fromExport(migrated.transcript)          (Chat.d.ts:412) → Chat.Service
  //   Schema.decodeEffect(Prompt.Prompt)(migrated.transcript)  (Prompt.d.ts:1303)
  const history = yield* Schema.decodeEffect(Prompt.Prompt)(migrated.transcript)

  return {
    // system is concat'd fresh at CallModel time, never stored:
    chatPrompt: history,                              // Prompt.concat(renderedSystem, history) at call time
    renderedSystem, promptHash, toolkit,
    carried: migrated.carried,
    budget: migrated.budget,
    pendingAsk: migrated.pendingAsk,
  }
})
```

**Deployment skew.** Eve's pinned-driver/latest-child split maps onto our
architecture as: the **Ring DO reducer is pinned** (it is the deployed
Worker code — a redeploy replaces it atomically, and its state is
version-enveloped rows, not code), while **each iteration re-links against
the current deployment** by construction, because Stage A runs inside
`interpret` on the live Layer graph. Live rings therefore adopt a redeploy
at the next iteration boundary with no state surgery, and the `promptHash`
stamp on every Trace event records exactly when the adoption happened —
which is Eve's behavior (`docs/concepts/execution-model-and-durability.md:20`)
with an audit trail they don't have.

---

## 3. Park/resume as our Ask on Durable Objects

**Eve's machinery.** Three named hooks: the session delivery hook re-keyed
to the continuation token at every park (`workflow-entry.ts:211-213`), the
per-turn inbox `` `${completionToken}:inbox` `` (`turn-workflow.ts:46`), and
the per-session `:auth` hook for OAuth callbacks
(`workflow-entry.ts:156-158`). Fast resumes racing hook disposal forced
per-turn control tokens (`workflow-entry.ts:161-165`). Two capabilities:
`continuationToken` (resume; single-owner, claim-linearized) vs
`sessionId` (observe; replayable stream). Pending HITL batches persist in
session state (`setPendingInputBatch`, `harness/input-requests.ts:354-368`);
unrelated input during a pending approval is **held and replayed, never
treated as denial** (`input-requests.ts:157-163` — deferred via
`queueDeferredStepInput`, replayed by `consumeDeferredStepInput:81-107`);
plain text matching an option id/label resolves structurally
(`resolveTextToResponses`, `input-requests.ts:243-262`); denials splice a
synthetic `execution-denied` tool-result so no orphaned `tool_use` survives
(`input-requests.ts:591-612`).

**Ours: no hooks exist.** A hook is a durable wait registered with a
workflow engine; on a Ring DO the equivalent is **a row plus an alarm** —
strictly simpler, and it dissolves Eve's entire raced-hook failure class
because there is nothing to dispose, re-key, or reclaim. Rows are truth,
wakes are hints (§3.1). The two-capability split maps onto our handle
verbs: `dispatch`/`send`/`steer`/`interrupt` are resume-plane capabilities
(all route through the one admission inbox); `Kernel.trace(ring, after)` is
the observe-plane capability (a pure storage read that neither wakes the
ring nor resets any keepalive — `Kernel.ts:113-117`).

**The Ask lifecycle on the Ring DO:**

```
1. REQUEST  — during a turn, a human-class tool call gates:
              Tool.dynamic("Approve", { needsApproval: true })   (Tool.d.ts:905, 104-133)
              effect/ai emits Response.ToolApprovalRequestPart
              { approvalId, toolCallId }                          (LanguageModel.js:699-711)
              The kernel translates it to the Ask command (§2.4):
              Ask { askId, kind: "approval" | "question" | "oauth" | "budget", payload }
              askId = deterministic from (ring, session, turn, callId)

2. PARK     — one transaction (plane 2 + plane 1):
              • Trace: Escalated event (durable, signed payload)
              • stash: StepState with transcript INCLUDING the
                tool-approval-request part (it is an assistant-message part —
                Response.d.ts:1164; Chat/Prompt carry it natively)
              • pendingAsk row { v, askId, kind, sig, expiresAt?, renderedRef }
              • plane 1: the run's ledger entry moves to state "parked-on-ask"
              • storage.setAlarm(expiresAt) for the timeout escalation
                (DurableObjectStorage.ts:262-265)
              The DO then simply RETURNS. No fiber survives; days of waiting
              cost nothing (the Eve property, without the hook).

3. ANSWER   — arrives over a world surface (§6) → Worker route → Router →
              ring.admit({ deliveryId, kind: "answer", item: { askId, verdict, ... } })
              admission is idempotent by deliveryId (kernel.ts:42-57);
              signature verified against the pendingAsk row's sig
              (answers arrive over the world — §9.3 authenticity).

4. RESUME   — the reducer wakes (alarm or admission dirty-signal), sees a
              runnable head whose parked ask is now answered:
              • approval-kind: append to the restored transcript
                Prompt.makeMessage("tool", { content: [
                  toolApprovalResponsePart({ approvalId, approved, reason })
                ]})                                               (Prompt.d.ts:599-622, 1194)
                and re-dispatch CallModel. effect/ai pre-resolves it:
                approved → executeApprovedToolCalls runs the real handler;
                denied → createDenialResults synthesizes the typed denied
                result the model sees; both are stripped before the wire
                (LanguageModel.js:455-478, 926-960). The pairing invariant
                is discharged BY THE LIBRARY.
              • question-kind (AskHuman-style tool with a callId): the
                answer becomes an ordinary tool-result part on the tool
                message — no approval machinery involved.
              • budget/oauth-kind: HARNESS-AUTHORED asks with no tool call
                in history. The answer is consumed by the kernel (extend
                budget window / complete auth) and MUST NOT append a tool
                message — Eve learned this exact rule
                (input-requests.ts:571-579: unmatched tool messages get
                provider 400s). A model-visible marker goes in as a user/
                system-part note instead, via the fold.
              • verdict amendments ("approved for session") persist as
                fold-visible ring state; the ratchet history is the Trace.
```

**Held-unrelated-input semantics.** Because there is only one inbox and it
is a ledger, this is free: an admission that is not an answer to the
pending ask (`kind: "work" | "steer"` or an answer with a non-matching
`askId`) is **appended behind the parked run** in plane 1 and simply not
promoted while the run's state is `parked-on-ask`. It is delivered at the
next iteration boundary after resume — exactly Eve's hold-and-replay, with
FIFO ordering they explicitly disclaim
(`execution-model-and-durability.md:53-61`; our `WorkQueue` seam promises
it). A plain-text answer arriving on the paired channel is matched against
the pending ask's structured options before being classified (Eve's
`resolveTextToResponses` move); on no match it is held input, not a denial.

Timeout: the alarm fires, the reducer emits the typed timeout `Escalated`
event and routes per policy (escalate to the oversight ring / auto-deny with
a typed denied result / extend). A run is never resurrected as an object —
"parked" is derivable from the two planes, per §9.5.

---

## 4. Budget leases down the delegation tree

**Eve's arithmetic** (`harness/subagent-token-budget.ts:16-46`): per axis,
`remaining = max(0, limit − used)`; a dispatch batch of N delegated calls
each get `floor(remaining / N)` (`fanoutSize` = count of `subagent-call`
actions in the batch, `execution/dispatch-runtime-actions-step.ts:95-100`);
`false` marks an uncapped axis. Child usage folds back into the parent's
session totals, so sequential batches see the net remainder. On every
inherited axis **the tighter of configured and inherited wins**
(`execution/create-session-step.ts:60-90`; depth is absolute so a child can
tighten but never extend past the root's cap). At the depth cap, subagent
tools stop being **advertised**; a forced call is blocked at execution
(`docs/subagents.mdx:91-97`).

**As ForkLoop lease arithmetic.** The lease is a durable row keyed by the
forking event id (§2.4: children are durably parent-linked by it),
written **in the same transaction as the fold/Trace write** that records
the `ForkLoop` command — budget accounting is per-command and transactional
(§2.4/§9.3):

```ts
/** Plane-2 row, versioned envelope (§7). Keyed by the forking event id. */
interface BudgetLease {
  readonly v: 1
  readonly leaseId: string                   // = ForkLoop event id (deterministic)
  readonly parent: { ring: string; session: string }
  readonly child: { ring: string; session: string }
  /** Per axis: the granted share. `false` = uncapped (Eve's marker). */
  readonly granted: { tokens?: number | false; usd?: number | false;
                      iterations?: number | false; wallClock?: number | false }
  /** Written at settlement; absent while outstanding. */
  readonly settled?: { spent: BudgetSpend; outcome: "halted" | "refused" | "exceeded" | "interrupted" }
}

// grant, at ForkLoop time (batch of N forks in one command batch):
const grant = (parent: BudgetLedger, axes: Axes, n: number): Grant =>
  mapAxes(axes, (axis) => {
    const remaining = remainingOf(parent, axis)              // configured − spent − Σ outstanding grants
    if (remaining === false) return false                    // uncapped parent ⇒ uncapped child
    return Math.floor(Math.max(0, remaining) / Math.max(1, n))
  })

// child-side effective limit: tighter-of-configured-and-inherited, per axis
const effective = (configured: number | false, inherited: number | false) =>
  configured === false ? inherited
  : inherited === false ? configured
  : Math.min(configured, inherited)
```

Two deliberate strengthenings over Eve:

1. **Outstanding leases are subtracted from the parent's remainder** at
   grant time (`remainingOf` above). Eve only nets *completed* children
   back into the totals; a parent that forks while a child is still running
   can over-grant. Our ledger reserves the grant when it is made.
2. **Reconciliation is transactional with the fold.** When the child
   settles (its `LoopExit` re-enters the parent as a trigger — §2.5 upward
   channel 2), one plane-2 transaction: mark the lease `settled` with actual
   spend (from the child's Trace usage events, `Response.Usage` shapes,
   `Response.d.ts:1655-1712`), debit the parent ledger by `spent`, release
   `granted − spent` back to the remainder, append the settlement Trace
   event, write the parent fold. Parent-scope death settles every
   outstanding lease as `interrupted` with spend-to-date (the child Trace
   is retained — §9.3).

**De-advertising at the depth cap** happens at Stage-A link time: the
interpretation pipeline (§2.2) counts the ring path depth; at the cap,
interpolated Agent/Loop refs are simply **not compiled into the Toolkit**
(the model never sees the option — cheaper and kinder than erroring), and
the ToolInterceptor hard-blocks a hallucinated forced call by synthesizing
the typed blocked result per the pairing invariant (§3.2). Both behaviors
are Eve's, positionally relocated: advertise-time in the linker,
execution-time in the interceptor seam.

---

## 5. Budget exhaustion: continuation Ask vs typed failure

**Eve** (`harness/session-limit-enforcement.ts`): the pre-model-call gate
`enforceSessionTokenLimit` (:108-125) parks sessions that can reach a human
(`mode === "conversation" || capabilities.requestInput === true`) on a
**deterministic, harness-authored continuation prompt** — no model call
happens (`parkOnSessionTokenLimit:133-177`); task-mode sessions fail fast
with structured `SESSION_TOKEN_LIMIT_REACHED` (:183-217). On resume,
`applySessionLimitContinuation` (:59-98): granted → `extendSessionTokenBudget`
resets the window and the step continues transparently; declined → a *user
decision, not an error* — conversation ends gracefully, task mode keeps the
structured failure so the parent tool call gets an error result.

**Ours: the mode split is the charter's type, not a runtime flag.** Eve's
`conversation`/`task` modality leaks into a dozen code paths (their own
docs flag "Task mode cannot wait for follow-up input",
`turn-workflow.ts:28,128-134`); for us the same information is already
carried by the term: whether the ring can ask is whether an
AskHuman-class tag is in its `Req` (and therefore in its Layer closure),
and whether it is bounded is `Out` (`Loop.ts:20-50` derives
`BudgetExceeded`/`Refused` in `Err` from the refs).

**Kernel behavior when a ceiling fires** (pre-command, per §2.4 — between
any two commands, never only at iteration boundaries):

```ts
const onCeiling = Effect.fn(function* (hit: CeilingHit, ring: RingCtx) {
  // 1. always: the typed event, the retained checkpoint
  yield* commit([budgetExceededEvent(hit)], stash(ring.state))   // fold + work item retained (Errors.ts:12-16)

  // 2. does this ring hold an Ask-capable Layer? Resolved at Stage-A link
  //    time: the charter interpolated a human-class tool, so its tag is in
  //    Req and the interpreter captured the implementation —
  //    probe pattern: Effect.serviceOption(AskHuman) during link (§2.2).
  if (ring.askCapable) {
    // 3a. INTERACTIVE: offer continuation — an Ask of kind "budget".
    //     Harness-authored: NO tool call exists in history, so the answer
    //     never appends a tool message (Eve's input-requests.ts:571-579 rule).
    yield* park(Ask({
      askId: askIdFor(ring, "budget-continuation", hit.ordinal),
      kind: "budget",
      payload: { limit: hit.budget, used: hit.used, resumeHint: hit.resumeHint,
                 options: ["continue", "stop"] },                 // 2-option structured question
    }))
    // on resume: "continue" → extend the window (a fold-visible ring-state
    //   amendment + Trace event — the autonomy-dial ratchet, §9.3), re-enter
    //   the loop at the same command; "stop" → fall through to 3b with
    //   cause: "declined" (a decision, not an error — but the parent still
    //   needs the typed exit, which is what Err is for).
  } else {
    // 3b. TASK-TYPED: fail typed. The ring retains fold + work item, so a
    //     re-dispatch after a budget raise CONTINUES from the checkpoint
    //     rather than restarting (Errors.ts doctrine: "a checkpoint, not a
    //     tombstone").
    return yield* Effect.fail(new BudgetExceeded({
      loop: ring.name, limit: hit.axis, budget: hit.budget, used: hit.used,
      resumeHint: hit.resumeHint ?? `raise ${hit.axis} and re-dispatch to resume`,
    }))
  }
})
```

Note what dissolved: Eve's structural limitation that a markdown schedule
can never ask a human is, for us, one Layer choice — a cron-triggered ring
whose charter interpolates `${AskHuman}` parks on the continuation Ask like
any interactive ring, because "scheduled" and "interactive" were never
modes, just triggers and capabilities (eve.md §4.12).

---

## 6. Channel-paired Ask rendering — the GitHub fixture Layer

**Eve.** Channels see the session's event stream, so approvals render
natively on the triggering surface (Slack buttons via Chat SDK cards) and
descendants' requests proxy to the root channel (eve.md §2.8). The webhook
itself is configured out-of-band — Eve never provisions the wire.

**Ours.** §9.3: "Ask Layers are channel-paired — the Layer implementing
`Ask` for a ring renders onto (and accepts answers from) the surface whose
EventSource triggered the run." And unlike Eve, declaring the subscription
*provisions* the wire (`EventSource.ts:33-74`: `subscribe` = plan-time
webhook provisioning + runtime stream, the two-phase bind).

Fixture-level sketch (`test/AI/fixtures/org/` vocabulary — `GitHubEvents`
from `github-events.ts:29-32`, the Ring DO from `cloudflare/kernel.ts`):

```ts
// test/AI/fixtures/org/cloudflare/ask-github.ts
/** The org's human-class tool contract (a term ref like any tool). */
export class AskHuman extends Context.Service<AskHuman, AskHumanService>()("org/AskHuman") {}

/**
 * Channel-paired implementation: renders asks as comments on the GitHub
 * issue that IS the run's work item (world identity rides in In — Process.ts:34-37),
 * and accepts answers as issue_comment events through the SAME channel.
 */
export const AskHumanGitHubLive = Layer.effect(AskHuman, Effect.gen(function* () {
  const github = yield* GitHub.Api                      // the org's existing tool physics
  const channel = yield* GitHubEvents                   // the SAME channel tag that triggered the ring

  return {
    // RENDER half — called by the kernel when an Ask command parks.
    render: Effect.fn(function* (ask: AskPayload, workItem: IssueRef) {
      // signed correlation marker; the sig is checked on the answer path
      const marker = `<!-- alchemy-ask:${ask.askId}:${ask.sig} -->`
      yield* github.createIssueComment({
        owner: workItem.owner, repo: workItem.repository, issue: workItem.number,
        body: renderAskBody(ask) + "\n" + marker,       // options rendered as a checklist / "reply approve|deny"
      })
    }),

    // ANSWER half — a *subscription*, not a poll: the channel Layer already
    // provisions the issue_comment webhook (GitHubRepositoryEventSourceLive);
    // this filters the verified stream down to ask answers.
    answers: (source: EventSource<IssueCommentEvent, GitHubEvents>) =>
      channel.subscribe(source).pipe(
        Stream.filterMap((ev) => parseAskMarkerFromReplyContext(ev)),   // finds the marker on the
        Stream.filter((a) => verifyAskSignature(a)),                    // parent comment; verifies sig
      ),
  }
}))
```

The wiring in the harness: when the kernel parks an approval/question Ask
on a ring whose triggering EventSource family is `GitHubEvents`, it calls
`AskHuman.render` with the run's work item (the issue ref — no correlation
table needed, because world identity rides in `In`); the answer stream is
plumbed into the ring's admission inbox as `kind: "answer"` keyed by the
GitHub delivery id (idempotent — redeliveries collapse,
`kernel.ts:42-57`), with the parsed `{ askId, verdict, text }` as the item.
From there §3's lifecycle takes over: verdict `approve`/`deny` becomes the
`ToolApprovalResponsePart` (`Prompt.d.ts:599-622`); free text is matched
against the ask's structured options first, and held as ordinary input if
it matches nothing. A descendant ring's Ask proxies to the root ring's
paired channel the same way Eve proxies HITL up
(`turn-workflow.ts:207-216`) — the child's Escalated event is a trigger the
parent subscribes to (§2.5 upward channel 2), and the parent's paired
AskHuman Layer renders it.

The autonomy dial never touches the charter: `AskHumanGitHubLive` vs
`AskHumanConsole` (dev) vs a Guardian LLM judge (§9.3) are Layer swaps on
the same `AskHuman` tag.

---

## 7. Versioned envelopes + migrators on every durable shape

**Eve's discipline.** `DurableSessionState`/`DurableSessionSnapshot` carry
`version` (`durable-session-store.ts:31-32,52-104`); migration runs on the
**read path** (`readDurableSession` → `migrateDurableSessionSnapshot`,
`:134-176`; unknown versions throw); workflow inputs are migrated on entry
(`migrateTurnWorkflowInput`, `turn-workflow.ts:36`); migrators live in a
dedicated module (`execution/durable-session-migrations/`); additive fields
ride without a bump (devalue preserves unknown POJO fields), shape breaks
bump + migrate (`durable-session-store.ts:10-16`).

**Applied to our four durable shapes:**

| Shape | Where it lives | Version field | Migration point |
|---|---|---|---|
| `KernelEvent` (Trace rows) | plane 2, append-only | `v: 1` — already landed (`src/AI/Kernel.ts:30-50`) | on read: `trace(ring, after)` decodes each row through the versioned schema union before yielding; rows are **never rewritten in place** |
| Fold snapshot / `StepStash` | plane 2 | `v: 1` on the envelope; the transcript inside uses effect/ai's own `Prompt.Prompt` codec (`Prompt.d.ts:1303`) **wrapped** in our envelope (PromptEncoded itself has no version field — gap G5) | `hydrate` (§2), first statement |
| Admission ledger rows | plane 1 | `v: 1` | reducer read: `admit` writes current; the runnable-head scan migrates stragglers lazily |
| Pending-ask rows + budget leases | plane 2 | `v: 1` | ask: answer-correlation read; lease: grant/settle read |

```ts
// one module per shape, mirroring eve's durable-session-migrations/
// packages/alchemy/src/Cloudflare/AI/migrations/fold.ts
export const migrateFoldRow = (raw: unknown): Effect.Effect<FoldRowV1, KernelError> =>
  Effect.suspend(() => {
    const v = (raw as { v?: number }).v
    switch (v) {
      case 1: return Schema.decodeEffect(FoldRowV1Schema)(raw)
      // case 2: return migrateV1toV2(yield* ...)   — total chain, oldest→current
      default: return Effect.fail(new KernelError({
        term: "fold", message: `unknown fold envelope version ${String(v)}` }))
      // unknown version routes to Resume policy as Terminal — never guess.
    }
  })
```

Rules adopted verbatim from Eve: migration is **read-path only** (the write
path always writes current — a pinned old reducer must still be able to
*ferry* newer envelopes it doesn't understand, which is why unknown
*optional* fields must survive round-trips: use `Schema` structs with
preserved rest, not lossy re-encodes); migrators are total functions
oldest→current chained, each covered by a fixture of the historical shape
checked into the test tree; and the conformance suite gets a property test:
every durable shape's current encoder output must decode through the
migration entry point unchanged.

---

## 8. What Eve's five failed cancellations teach the Ring DO cancel path

Eve's post-mortem trail (#118/#127/#128/#135, #230, #347 —
`research/turn-cancellation-harness-abort.md:9-41`, eve.md §2.5): every
failure was in the **trigger/cross-process hook layer** — raced hooks in
the driver, hook dispose-before-reclaim determinism bugs, duplicate step
execution under one correlation id, delegate adoption races. The
in-process abort propagation "converged on the same shape three times"
trivially — Effect's fiber interruption gives us that layer for free. The
danger zone is exactly what our architecture removes: there are no hooks,
no cross-process reclaim, no second control plane. The checklist below is
the conformance-suite contract that keeps it that way.

**Ring DO cancel-path conformance checklist:**

1. **Cancel is a stimulus through the one inbox.** `interrupt()` admits
   `{ kind: "control", item: { type: "interrupt" } }` with a deterministic
   delivery id (already in the mock — `kernel.ts:204-212`). There is no
   other entry point. Duplicate cancels collapse idempotently in the
   ledger. *Test: two concurrent interrupts → one control row, one receipt
   each.*
2. **A cancellation is never classified retryable/recoverable.** The Resume
   policy must never map a cancel-caused checkpoint to `Retry`; the
   `Recovered` classifier treats `interrupted` as terminal for the run.
   *Test: kill the DO mid-cancel-processing; on boot the run settles
   interrupted, never re-executes.* [§9.4, verbatim]
3. **Cancelling parked work is a row update, not a wake-and-race.** Cancel
   of a run in `parked-on-ask`: settle the pendingAsk row as cancelled,
   delete the alarm, synthesize the typed interrupted tool result for the
   in-flight `callId` (pairing invariant extends to abandonment — §2.4),
   run the fold, leave the model-visible marker in the Trace. The late
   answer (see 4) hits a settled row. *Test: park → cancel → answer
   arrives; answer gets a "settled" receipt, no resume.*
4. **Cancel/answer races are linearized by the ledger, not by disposal.**
   DO single-threading + ordered admission means first-admitted wins;
   the loser receives a terminal *receipt* (not an error). This is the
   structural fix for Eve's dispose-before-reclaim class: there is nothing
   to dispose. *Test: interleave answer and cancel admissions in both
   orders; assert both orders produce consistent terminal state and no
   duplicate side effects.*
5. **Cancel capability is scoped like Eve's cancelToken.** An interrupt
   targets `(ring, session/workItem, turn?)`; a stale cancel (run already
   halted) is a no-op receipt. Under `AI.concurrency > 1` the run key is
   mandatory (Process.ts:23-27 already requires it for steer). *Test:
   cancel after halt → receipt `{ settled: "already-halted" }`, no Trace
   mutation.*
6. **Cross-ring propagation is admission, not RPC-abort.** Parent-scope
   death settles each outstanding `ForkLoop` lease as `interrupted`
   (spend-to-date debited, child Trace retained — §9.3) and admits a
   control stimulus to each child ring keyed by the forking event id. A
   child that misses the wake converges anyway on next wake (rows are
   truth). *Test: kill the parent DO with two live children; both children
   settle interrupted; leases reconcile; child Traces readable.*
7. **Identify cancellation by tag across serialization boundaries, never
   `instanceof`** (Eve's `isTurnCancellation`-by-`name` lesson —
   everything crossing DO storage or RPC is structurally re-hydrated).
   *Lint + test: the interruption marker survives
   `structuredClone` and re-decode.*
8. **In-flight tools settle as interrupted results, never silently
   re-execute** — including the approval-resumed execution path (§3):
   if cancel lands between answer admission and the resumed CallModel,
   the approved-but-unexecuted call settles as interrupted, not executed.
   *Test: approve → cancel in same wake window.*
9. **Chaos suite** (already the §3.2 deliverable, extended with the cancel
   axis): kill the DO mid-turn, mid-fold, mid-park, mid-cancel; assert
   convergence from rows alone on every boot.

---

## Gap list

Honest gaps between what the design needs and what the verified surfaces
provide today.

- **G1 — effect/ai `Chat` is not transactional.** `Chat.Service.history` is
  an in-memory `Ref` (`Chat.d.ts:89`); `Chat.Persisted.save` writes *after*
  generation (`Chat.d.ts:530-539`) and cannot join our
  fold+trace+ledger `storage.transaction`. Resolution: use `Chat` only as
  an in-turn convenience (or skip it); the durable transcript is
  `Prompt.PromptEncoded` written by *our* stash inside the DO transaction.
  `Cloudflare.AI.DurableObjectChatPersistence` remains useful for
  simple chat DOs, not for the kernel's fold path.
- **G2 — approval-resumed execution happens inside `LanguageModel`.** On
  resume, `executeApprovedToolCalls` runs the real handler *before* the
  provider call, inside `generateText` (`LanguageModel.js:455-467`) — i.e.
  outside our per-command journal. Options: (a) accept coarse journaling
  for the one approval-resumed call (it is exactly one call, already
  Trace-evented via the Ask lifecycle); or (b) pre-resolve ourselves:
  detect the answered approval, run `toolkit.handle` under our journal,
  append the tool-result part, and strip the approval parts before
  dispatching (mirroring `stripResolvedApprovals`,
  `LanguageModel.js:926-960`). Recommend (b) at the doFiber tier for
  invariant uniformity; (a) is acceptable at the Workflow tier.
- **G3 — `FinishReason: "pause"` provider coverage unverified.** The
  literal exists (`Response.d.ts:1632-1641`) and the approval flow implies
  it, but I did not verify which provider adapters emit it when a turn
  ends on an unresolved approval. The kernel must treat "response contains
  a `tool-approval-request` part" as the park trigger, not the finish
  reason.
- **G4 — no cache-breakpoint helper.** Eve applies Anthropic cache markers
  to system + last tool (`tool-loop.ts:820,847`,
  `prompt-cache.ts:100`). effect/ai has no first-class equivalent; the
  seam is per-message/part `options: ProviderOptions` (open
  `Record<string, Json>`, `Prompt.d.ts:16-24`) — our
  `markCacheBoundaries` (§3.2 fold pipeline) must write provider-specific
  options keys and verify the Anthropic adapter honors them. Unverified;
  scoped work.
- **G5 — `PromptEncoded` has no version field** (`Prompt.d.ts:1291-1296`).
  Our envelope supplies the version (§7); if effect/ai changes its message
  encoding, our migrator chain absorbs it — but we should pin the effect
  version per deployment and add a conformance fixture of a serialized
  transcript to detect silent codec drift.
- **G6 — usage fields are all optional** (`Response.d.ts:1655-1712`),
  so `usd`/token ceilings need the declared unknown-usage policy (§2.4);
  budget enforcement under unknown usage is already a named §9.4 risk.
- **G7 — Workflow-tier `waitForEvent` not sketched.** This report's Ask
  path is the Ring-DO (row+alarm) rung. The `Fix`-scale Workflow rung
  (`step.waitForEvent`, §3.2) needs its own mapping against the real
  Cloudflare Workflows binding once the harness reaches that tier; the
  Ask row schema is designed to be the shared shape.
- **G8 — the `Recovered` mid-stream classification is coarse.** Deltas are
  non-durable by design, so an eviction mid-`streamText` loses partials;
  policy is re-dispatch-at-most-once (Flue's `resume` class). Fine per
  §9.3, but means the turn tier cannot ship Eve-style byte-replayable
  streams (`startIndex`) without a delta journal — deliberately out of
  scope (durable vs live is a type-level split).

---

## Implementation order — Ring DO durability + Ask path feeding `CloudflareAgent.test.ts`

Ordered so every step lands with tests against the previous steps; steps
1–4 are pure/DO-only (no model), 5+ bring in effect/ai.

1. **Versioned envelopes + read-path migrators** (§7): the four shape
   schemas + `migrate*` modules + property test (encode→migrate = id).
   Pure; unblocks every row written later.
2. **Plane 1 generalized**: admission ledger kinds
   `work | steer | control | answer`, receipts, runnable-head state
   machine (`runnable | running | parked-on-ask`), edge-triggered dirty
   signal via alarm. Extends the existing mock (`kernel.ts:42-57`).
   Tests: idempotent admission, held-input ordering, cancel checklist
   items 1/4/5.
3. **Plane 2**: trace append + fold stash in one `storage.transaction`;
   `trace(after)` replay (tail live later); deterministic event ids.
   Tests: same-transaction atomicity under injected faults.
4. **StepStash + `hydrate(fold, term)`** (§2) with `Prompt.Prompt`
   codec round-trip and the promptHash fossil check → `Resume` policy.
   Tests: kill-mid-write recovery, fossil → Retry-with-fresh-render.
5. **The turn driver** (§1): `LanguageModel.generateText` (upgrade to
   `streamText` after) with `disableToolCallResolution: true`,
   `toolkit.handle` per call, per-command journal, pairing repair-on-read,
   ToolInterceptor pass-through default. Tests with a scripted
   `LanguageModel.make` mock (`LanguageModel.d.ts:478-492`) — the
   MockModel Layer the conformance suite standardizes on.
6. **Budget ledger** (§4 spend side + §5): per-command decrement in the
   commit transaction; `BudgetExceeded` park-or-fail decision from the
   linked term's ask-capability. Tests: ceiling between two tool
   commands; task-typed ring fails typed with resumeHint; re-dispatch
   after raise continues from checkpoint.
7. **The Ask path** (§3): pendingAsk rows + alarm timeouts; approval-kind
   via `needsApproval`/`ToolApprovalRequestPart`; answer admission with
   signature verification; resume via `ToolApprovalResponsePart` append
   (choose G2 option b); held-unrelated-input; budget-continuation kind
   (harness-authored, no tool message). Tests: full
   request→park→answer→resume against the mock model; cancel checklist
   items 3/8.
8. **ForkLoop leases** (§4): grant with outstanding-lease reservation,
   settlement reconciliation transactional with the fold, de-advertising
   at the depth cap in the Stage-A linker. Tests: fan-out of N cannot
   exceed the remainder; parent death settles leases (checklist 6).
9. **Channel-paired GitHub Ask fixture** (§6): `AskHumanGitHubLive` in
   `test/AI/fixtures/org/cloudflare/`, wired to `GitHubEvents`;
   `CloudflareAgent.test.ts` scenario: issue-triggered run → approval Ask
   rendered as a comment → simulated `issue_comment` webhook admission →
   resume → halt. This is the end-to-end test the whole ladder feeds.
10. **Cancel conformance + chaos suite** (§8): the nine checklist items as
    named tests; DO-kill injection at every stash point from §1.

---

## Honesty notes

- All effect/ai claims were verified against the `.d.ts` files cited, and
  the approval/pre-resolution behavior additionally against
  `LanguageModel.js` (compiled output in this repo's `node_modules`) — the
  `.d.ts` alone does not document the pre-resolution protocol.
- I did not run any Eve code; Eve behavior claims trace to the vendored
  source lines cited and to `designs/ai/reports/eve.md`.
- `stopWhen: isStepCount(1)` (`tool-loop.ts:851`) is an AI SDK
  `ToolLoopAgent` setting; my claim that effect/ai needs no equivalent
  rests on reading `LanguageModel.js` `generateContent`/`streamContent` —
  neither contains a loop back to the provider after tool resolution.
- G3 (provider emission of `"pause"`) and G4 (Anthropic cache options via
  message `options`) are flagged unverified rather than asserted.
