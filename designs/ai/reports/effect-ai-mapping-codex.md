# Codex engine patterns on effect/ai — implementation mapping

How OpenAI Codex's engine patterns (SQ/EQ, turn loop, approvals-as-amendments, Guardian,
/goal loop, rollout persistence, tool-pairing repair) map onto **effect v4's
`effect/unstable/ai`** modules inside the Alchemy AI kernel (Phase 2 step machine + loop
runtime, Phase 3 Cloudflare Ring DO harness).

Every effect/ai API cited below was verified against the installed `.d.ts` files under
`node_modules/effect/dist/unstable/ai/` (referenced as `ai/<Module>.d.ts:<line>`). Every
Codex claim is cited into `.vendor/codex/codex-rs/` (referenced as `codex:<path>:<line>`).
Design-doc references are to `designs/ai/alchemy-ai-design.md` (§) and the kernel sources
in `packages/alchemy/src/AI/`.

**The one-sentence verdict up front**: everything Codex's engine does at runtime is
representable on effect/ai *except* four things — provider-item id stability for prompt
caching, sticky/resumable model streams, a context-capable `needsApproval` predicate, and
serializable response-id tracking — and about half of Codex's runtime machinery
(granular approval config, role layering, tool exposure filtering, the goal-state
semaphore, the hooks engine) dissolves into our typed Layer graph and the Ring DO's
single-threaded inbox.

---

## 1. SQ/EQ as our surface: the correlation discipline for Stage B

### What Codex does

One totally-ordered submission queue in (`Submission { id, op }`), one event stream out,
every `Event` correlated to the submission that caused it by `sub_id`
(`codex:protocol/src/protocol.rs:527` — `Op`, `:1279` — `EventMsg`). Two details are
load-bearing:

- **Settings mutations ride the same queue as turns** so caller order is preserved
  (`Op::ThreadSettings`, `codex:protocol/src/protocol.rs:569–576`: "uses the same
  submission queue as turn starts so app-server can preserve caller order between both
  kinds of mutation").
- **Steering targets a specific turn id** and is rejected with typed reasons on mismatch
  (`SteerInputError::ExpectedTurnMismatch`, `codex:core/src/session/mod.rs:246–283`) —
  see mapping 7.

### Our mapping

Codex's SQ = the Ring DO's **admission ledger** (plane 1, §3.1): work items, steers,
cancels, budget edits, charter redeploys — all stimuli through one ordered, idempotent
inbox keyed by delivery id. Codex's EQ = `KernelEvent` with its `cause` field
(`src/AI/Kernel.ts:46`). The discipline that upgrades this from "similar shape" to
"implementable contract" is **every Command gets a deterministic id**, and every
effect/ai interaction maps to Begin/End events carrying that id.

### Id derivation

`step` is pure — no id generation inside it (§2.4). Ids derive from position:

```ts
// src/AI/Ids.ts (proposed)

/** A run is keyed by (term, work item): world identity rides in In (§2.1). */
export type SessionKey = string // `${promptHash}:${workItemKey}`

/** Deterministic command identity: derived from position, never minted. */
export const commandId = (
  session: SessionKey,
  stepIndex: number, // increments once per step() invocation
  ordinal: number,   // index of the command in step()'s returned Command[]
): string => `cmd:${session}:${stepIndex}:${ordinal}`

/** Durable event identity derives from the command that produced it. */
export const eventId = (cause: string, kind: string, disambiguator?: string): string =>
  disambiguator === undefined ? `${cause}:${kind}` : `${cause}:${kind}:${disambiguator}`
```

Two id spaces must not be conflated (Codex keeps them separate too — its `call_id` is
provider-minted, its item `id` is Responses-API-minted):

| Id | Minted by | Used for |
|---|---|---|
| `commandId` | us, from `(session, stepIndex, ordinal)` | Trace event ids, `cause` chains, budget rows, ask correlation, steer targeting |
| `ToolCallPart.id` | the model/provider (`ai/Response.d.ts:863–867`) | tool-pairing (call ↔ result), suspension bookkeeping (§2.4: key on callId, never tool name) |

The bridge: a `ToolRequested` event's id is `eventId(modelCmdId, "call", part.id)` and
its payload carries the provider `callId`. Replay collides idempotently on both.

**Where effect/ai's `IdGenerator` fits.** Provider adapters fill missing part ids via the
`IdGenerator` service (`LanguageModel.make`'s hooks require it,
`ai/LanguageModel.d.ts:482–486`). Its `Service` is just
`{ generateId: () => Effect<string> }` (`ai/IdGenerator.d.ts:80–82`), so the kernel
provides a **deterministic per-turn generator** — a pure counter seeded from
`(session, stepIndex)` — instead of `defaultIdGenerator` (`ai/IdGenerator.d.ts:156`,
random nanoid). Then even provider-gap-filled ids are replay-stable:

```ts
const deterministicIds = (session: SessionKey, stepIndex: number): IdGenerator.Service => {
  let n = 0
  return { generateId: () => Effect.sync(() => `gen:${session}:${stepIndex}:${n++}`) }
}
// provided per model command:
Effect.provideService(IdGenerator.IdGenerator, deterministicIds(session, stepIndex))
```

### Emission points around `streamText`

Stage B drives `LanguageModel.streamText` (`ai/LanguageModel.d.ts:73–85`) with
`disableToolCallResolution: true` (`ai/LanguageModel.d.ts:164–172`) — the kernel owns
tool scheduling, gating, and pairing; effect/ai's auto-resolution loop is bypassed. The
stream yields `Response.StreamPart<Tools>` (`ai/Response.d.ts:109`), and each part class
has exactly one emission mapping:

```ts
// Stage B interpreter: one CallModel command → events + one ModelResponse feedback
const runCallModel = (cmd: CallModel) =>
  Effect.gen(function* () {
    // BEGIN — emitted before any provider I/O (emission ordering is normative, §2.3)
    yield* emit(durable("ModelRequested", cmd.id, { model: cmd.model, promptHash }))

    const parts = yield* LanguageModel.streamText({
      prompt: cmd.prompt,                    // Prompt.RawInput (ai/LanguageModel.d.ts:135)
      toolkit,                               // Toolkit.WithHandler (ai/LanguageModel.d.ts:140)
      toolChoice: cmd.toolChoice,            // ai/LanguageModel.d.ts:156, :212–217
      disableToolCallResolution: true,       // ai/LanguageModel.d.ts:172
    }).pipe(
      Stream.tap((part) => {
        switch (part.type) {
          // live-only deltas: durable: false, no seq, excluded from folds (§2.3)
          case "text-delta":                 // ai/Response.d.ts:356
          case "reasoning-delta":            // ai/Response.d.ts:560
          case "tool-params-delta":          // ai/Response.d.ts:734
            return emit(live("ModelDelta", { cause: cmd.id, part }))
          // durable: the model requested a call — BEFORE any gate (§2.3)
          case "tool-call":                  // ai/Response.d.ts:863
            return emit(durable("ToolRequested", eventId(cmd.id, "call", part.id), {
              callId: part.id, name: part.name, params: part.params,
              providerExecuted: part.providerExecuted,
            }))
          // durable: provider-executed results arrive in-band (typed exemption, §2.4)
          case "tool-result":                // ai/Response.d.ts:944–1049
            return part.preliminary
              ? emit(live("ToolProgress", { cause: cmd.id, part }))
              : emit(durable(part.isFailure ? "ToolFailed" : "ToolCompleted",
                  eventId(cmd.id, "result", part.id), { callId: part.id, result: part.encodedResult }))
          case "tool-approval-request":      // ai/Response.d.ts:1164
            return emit(durable("Escalated", eventId(cmd.id, "ask", part.approvalId), {
              approvalId: part.approvalId, callId: part.toolCallId,
            }))
          case "response-metadata":          // ai/Response.d.ts:1548 — provider responseId bookmark
            return emit(durable("ModelResponseId", eventId(cmd.id, "rid"), { part }))
          // END — usage + finish reason (budget decrements in the same txn, §2.4)
          case "finish":                     // ai/Response.d.ts:1739
            return emit(durable("ModelCompleted", eventId(cmd.id, "finish"), {
              reason: part.reason,           // FinishReason, ai/Response.d.ts:1632–1641
              usage: part.usage,             // cache-read/write/uncached splits, ai/Response.d.ts:1655–1707
            }))
          case "error":                      // ai/Response.d.ts:1826
            return emit(durable("ModelFailed", eventId(cmd.id, "error"), { error: part }))
          default:
            return Effect.void               // text-start/end, reasoning-start/end, source, file
        }
      }),
      Stream.runCollect,
    )

    return Feedback.ModelResponse({ commandId: cmd.id, parts })
  })
```

**Settings through the same inbox** (Codex insight 11): the Ring DO exposes no side-band
RPC for budget edits or charter swaps. They are ledger rows like any dispatch; the loop
runtime drains them at the iteration boundary, so a budget change can never race a
dispatch — exactly the property Codex buys with `Op::ThreadSettings` on the SQ, and we
get the total order for free from DO single-threading.

---

## 2. Tool-pairing repair-on-read over `Prompt`

### What Codex does

`ensure_call_outputs_present` (`codex:core/src/context_manager/normalize.rs:17–127`) runs
**every time history is materialized** for a sampling request. It scans for
`FunctionCall` / `ToolSearchCall` / `CustomToolCall` / `LocalShellCall` items with no
matching output `call_id`, and inserts a synthetic `"aborted"` output **immediately after
the call** (reverse-index insertion, `normalize.rs:123–126`). Synthetic outputs get
**deterministic ids** via UUIDv5 in a fixed namespace because "Changing this value would
change model-visible IDs and invalidate prompt caches" (`normalize.rs:14–15`, and the
doc on `synthetic_output_id` at `:129–142`: normalization "can run repeatedly without
persisting its synthetic outputs, so the namespace and name format must remain stable
across retries and resumes"). Server-executed tool-search outputs are exempt
(`normalize.rs:203`).

### The effect/ai substrate — what Prompt actually gives us

Verified message/part shapes (`ai/Prompt.d.ts`):

- `Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage` (`:1248`).
- `AssistantMessagePart = TextPart | FilePart | ReasoningPart | ToolCallPart |
  ToolResultPart | ToolApprovalRequestPart` (`:1078`) — tool calls live in assistant
  messages; **provider-executed results may also live there** (see the constructor
  example at `:1040–1060`).
- `ToolMessagePart = ToolResultPart | ToolApprovalResponsePart` (`:1194`) — framework
  results live in tool messages.
- `ToolCallPart = { id, name, params, providerExecuted }` (`:396–413`).
- `ToolResultPart = { id, name, isFailure, result }` (`:492–509`) — **keyed by the call
  id only; there is no separate item id.**
- Synthetic results are insertable with `Prompt.makePart("tool-result", …)` (`:113–132`)
  wrapped in `Prompt.makeMessage("tool", { content })` (`:810–818`);
  `Prompt.fromMessages` rebuilds a `Prompt` (`:1401`).

That last verified fact is a genuine simplification over Codex: because effect/ai
results carry **no id of their own** — only the `id` of the call they answer — a
synthetic fill is *deterministic by construction*. The UUIDv5 namespace machinery exists
in Codex only because Responses-API output items have their own item ids. Our
cache-stability rule reduces to: **the synthetic result's content must be a pure function
of the orphaned call** (constant text + the call id), which the sketch below satisfies.

### The pass

A pure normalization `ReadonlyArray<Prompt.Message> → Prompt.Prompt`, run every time
Trace-derived messages are materialized before `CallModel` — after any fold, trim, or
compaction, composing with all of them (§2.4 "repair-on-read"; pipeline order
`fold → render → repair → markCacheBoundaries → CallModel`):

```ts
// src/AI/Pairing.ts (proposed) — pure, deterministic, idempotent
import * as Prompt from "effect/unstable/ai/Prompt"

const SYNTHETIC_ABORTED = "aborted" as const // changing this invalidates prompt caches

export const ensureToolResultsPresent = (
  messages: ReadonlyArray<Prompt.Message>,
): ReadonlyArray<Prompt.Message> => {
  // 1. index every result id (assistant-embedded AND tool-message results)
  const resultIds = new Set<string>()
  const approvalResponseIds = new Set<string>()
  for (const m of messages) {
    if (m.role === "assistant" || m.role === "tool") {
      for (const part of m.content) {
        if (typeof part !== "string" && part.type === "tool-result") resultIds.add(part.id)
        if (typeof part !== "string" && part.type === "tool-approval-response") {
          approvalResponseIds.add(part.approvalId)
        }
      }
    }
  }
  // 2. walk assistant messages; collect orphaned calls per message index
  const inserts: Array<[index: number, message: Prompt.ToolMessage]> = []
  messages.forEach((m, idx) => {
    if (m.role !== "assistant") return
    const orphans = m.content.filter(
      (p): p is Prompt.ToolCallPart =>
        p.type === "tool-call" &&
        !p.providerExecuted &&            // provider-executed: typed exemption (§2.4;
        !resultIds.has(p.id),             //   Codex normalize.rs:203 server-execution analog)
    )
    // dangling approval requests are repaired as denials, same doctrine
    const danglingApprovals = m.content.filter(
      (p): p is Prompt.ToolApprovalRequestPart =>
        p.type === "tool-approval-request" && !approvalResponseIds.has(p.approvalId),
    )
    if (orphans.length === 0 && danglingApprovals.length === 0) return
    inserts.push([idx, Prompt.makeMessage("tool", {
      content: [
        ...danglingApprovals.map((p) =>
          Prompt.makePart("tool-approval-response", {
            approvalId: p.approvalId, approved: false, reason: SYNTHETIC_ABORTED,
          })),
        ...orphans.map((p) =>
          Prompt.makePart("tool-result", {
            id: p.id, name: p.name, isFailure: true, result: SYNTHETIC_ABORTED,
          })),
      ],
    })])
  })
  // 3. insert immediately after the call's message, reverse order (normalize.rs:123–126)
  const out = [...messages]
  for (const [idx, msg] of inserts.reverse()) out.splice(idx + 1, 0, msg)
  return out
}
```

Property tests (mirroring what Codex tests, per `designs/ai/reports/codex.md` insight 2):
for arbitrary message lists and arbitrary trims, (a) the output is well-paired — every
non-provider-executed `tool-call` has exactly one `tool-result`; (b) the pass is
idempotent — `f(f(xs)) = f(xs)`; (c) it is deterministic — equal inputs yield
byte-equal outputs (the cache-stability property); (d) it composes with
`remove_orphan_outputs`-style trims (a result whose call was trimmed away is dropped,
mirroring `normalize.rs:144–217`).

### The truncated-args-fail-the-batch rule

Codex/Academy lore adopted in §2.4: a `length`-truncated response's tool calls fail
**wholesale** — salvage-parsed JSON may validate while incomplete. On effect/ai this is a
**driver rule at Response-fold time**, not a prompt-normalization rule, because by the
time parts reach `Prompt`, params are already parsed. Verified hooks: `FinishPart.reason`
is typed `"length"` among `FinishReason` literals (`ai/Response.d.ts:1632–1641, :1739–1743`).

```ts
// in the step machine's ModelResponse handling:
const finish = parts.find((p) => p.type === "finish")
const calls = parts.filter((p) => p.type === "tool-call")
if (finish?.reason === "length" && calls.length > 0) {
  // fail the whole batch: never execute, synthesize typed failures for every call
  return calls.map((c) =>
    Feedback.ToolResult({
      callId: c.id, name: c.name, isFailure: true,
      result: "aborted: response truncated (length); the entire tool batch was discarded",
    }))
}
```

The synthesized failures then flow into the Trace as `ToolFailed` events and into the
next prompt as ordinary results — the model sees the truncation, never invents success.

---

## 3. Approvals-as-amendments + the Guardian

### What Codex does

`ReviewDecision` (`codex:protocol/src/protocol.rs:4025–4057`) is not a boolean:

```
Approved | ApprovedExecpolicyAmendment { proposed_execpolicy_amendment }
| ApprovedForSession | NetworkPolicyAmendment { network_policy_amendment }
| Denied | TimedOut | Abort
```

Every approval is an opportunity to *narrow future approvals* — the dialog is the policy
editor. The Guardian (`codex:core/src/guardian/mod.rs:1–12`) inserts an LLM judge between
"model wants X" and "human sees a prompt": compact transcript reconstruction
(token-capped, `:54–59`), strict-JSON assessment
(`GuardianAssessment { risk_level, user_authorization, outcome, rationale }`, `:63–69`),
**fail closed** on timeout (90s, `:47`) / malformed output, and a denial circuit breaker
(3 consecutive denials per turn or 10 in a 50-review window → interrupt the turn,
`:49–51, :98–133`), with human override as a dedicated op
(`Op::ApproveGuardianDeniedAction`).

### The Ask payload/answer schemas

`Ask` is our one durable-wait primitive (§2.4); answers are *verdict + optional
amendment* (§9.3). Typed:

```ts
// src/AI/Ask.ts (proposed)
export type AskPayload =
  | { kind: "approval"; commandId: string; callId: string; tool: string
      params: unknown; risk?: RiskAnnotations }            // from Tool.Readonly/Destructive/
  | { kind: "question"; commandId: string; text: string    //   OpenWorld annotations,
      options: readonly [string, string, ...string[]] }    //   ai/Tool.d.ts:1248–1313
  | { kind: "oauth"; commandId: string; url: string }
  | { kind: "budgetContinuation"; commandId: string; exceeded: BudgetExceeded }

export type PolicyAmendment =                               // ReviewDecision analog
  | { kind: "forSession"; scopeKey: string }                // ApprovedForSession
  | { kind: "rule"; toolPattern: string; paramsPattern?: string }  // ApprovedExecpolicyAmendment
  | { kind: "network"; host: string; action: "allow" | "deny" }    // NetworkPolicyAmendment

export type AskAnswer = {
  readonly askId: string                                    // signed; verified on arrival (§9.3)
  readonly verdict: "approve" | "deny" | "abort"            // deny = typed model-visible result;
  readonly amendment?: PolicyAmendment                      //   abort = control signal (halt)
  readonly correction?: string                              // correct-with-feedback (OpenCode 3rd verb)
}
```

The amendment persists as a **fold-visible `PolicyAmended` Trace event** — ring state the
autonomy dial ratchets through, with the ratchet history durably in the Trace (§9.3).

### How this rides effect/ai's approval machinery

effect/ai has a native approval loop, verified end to end:

- `Tool.make(name, { needsApproval })` — `boolean` or
  `(params, { toolCallId, messages }) => boolean | Effect<boolean>`
  (`ai/Tool.d.ts:104–133, :854`).
- When approval is needed, the stream yields a `ToolApprovalRequestPart
  { approvalId, toolCallId }` (`ai/Response.d.ts:1164`), which `Prompt.fromResponseParts`
  folds into the assistant message (`ai/Prompt.d.ts:1441, :1078`).
- The resolution re-enters as a `ToolMessage` containing `ToolApprovalResponsePart
  { approvalId, approved, reason? }` (`ai/Prompt.d.ts:599–612, :1194`).

The mapping: the kernel parks on `Escalated` (the `tool-approval-request` emission point
from mapping 1), and the `AskAnswer` resumes the run by appending the
`tool-approval-response` part — `approved: false` with `reason` carrying the denial text
is exactly Codex's "denied but continue the session" (`ReviewDecision::Denied` doc,
`protocol.rs:4046–4049`). **The amendment does not enter the Prompt at all** — it is
kernel state consulted by the *next* approval decision. `verdict: "abort"` maps to
`ReviewDecision::Abort` and is a control-plane halt, not a message.

One verified constraint shapes the implementation: `NeedsApprovalFunction` returns
`Effect.Effect<boolean>` — **`R = never`** (`ai/Tool.d.ts:120`). The predicate cannot
pull our policy store from ambient context per-call. So the amendment store is resolved
at **Stage-A link time** and closed over:

```ts
// Stage A: compile a term tool into a Toolkit entry with the amendment-aware gate
const policy = yield* RingPolicyState          // harness seam; resolved at Layer construction
const tool = Tool.make(ref.name, {
  description: renderedDescription,
  parameters: ref.parameters,
  needsApproval: (params, ctx) =>              // closes over `policy` — R must be never
    Effect.map(policy.matches(ref.name, params), (matched) => !matched),
})
```

### The Guardian as an alternative `Approve` Layer

No new term (design §9.3: "The Guardian pattern is a Layer, not a term"). It implements
the same `Approve` contract as `ApproveAuto`/`ApproveHuman`, judged by
`LanguageModel.generateObject` (`ai/LanguageModel.d.ts:69, :564` — schema-constrained
output, returns `GenerateObjectResponse.value: A` at `:305–311`):

```ts
// packages/alchemy/src/AI/Guardian.ts (proposed outline)
const GuardianAssessment = Schema.Struct({    // mirrors codex guardian/mod.rs:63–69
  riskLevel: Schema.Literals(["low", "medium", "high"]),
  userAuthorization: Schema.Literals(["explicit", "implicit", "none"]),
  outcome: Schema.Literals(["allow", "deny"]),
  rationale: Schema.String,
})

export const ApproveGuardian = (options?: {
  timeout?: Duration.DurationInput            // default "90 seconds" (guardian/mod.rs:47)
  maxConsecutiveDenials?: number              // default 3            (guardian/mod.rs:49)
  maxRecentDenials?: number                   // default 10 in window 50 (guardian/mod.rs:50–51)
}): Layer.Layer<Approve, never, LanguageModel.LanguageModel | Ask> =>
  Layer.effect(Approve, Effect.gen(function* () {
    const ask = yield* Ask                    // the human appellate court (escalation surface)
    const breaker = yield* makeDenialBreaker(options)   // per-run, keyed by session

    return (request: ApprovalRequest) => Effect.gen(function* () {
      const assessment = yield* LanguageModel.generateObject({
        prompt: renderGuardianPrompt(request),          // token-capped transcript slice
        schema: GuardianAssessment,                     //   (guardian/mod.rs:54–59 caps)
        objectName: "guardian_assessment",
        toolChoice: "none",
      }).pipe(
        Effect.timeout(options?.timeout ?? "90 seconds"),
        Effect.option,                        // timeout | malformed | provider error →
      )                                       //   fail CLOSED (guardian/mod.rs:11)

      if (Option.isNone(assessment) || assessment.value.value.outcome === "deny") {
        const action = yield* breaker.recordDenial(request.session)
        if (action._tag === "InterruptTurn") {
          // circuit breaker: stop burning reviews; surface to the human as an Ask
          return yield* ask.escalate(request, { reason: "guardian-circuit-breaker" })
        }
        // typed denial the model sees; human may override via ordinary AskAnswer
        // referencing the denied commandId (Op::ApproveGuardianDeniedAction analog)
        return Verdict.denied(rationaleOf(assessment))
      }
      yield* breaker.recordNonDenial(request.session)
      return Verdict.approved()
    })
  }))
```

Judge-on-cheap-model needs no new machinery: `CallModel` carries the model as per-turn
data (§2.4), and the Guardian layer's `LanguageModel` requirement is satisfied
independently of the worker's — provide a cheap provider Layer to `ApproveGuardian`
only. Composition is the point: guardian-denies ⇒ escalate-to-human is the layer
*requiring* `Ask`, so `ApproveGuardian` sits strictly between `ApproveAuto` and
`ApproveHuman` in the autonomy lattice, and a charter that never interpolates
`${Approve}` can't be granted any of them (capability denial by omission).

---

## 4. The /goal loop → trigger/halt/Refused on the Ring DO

### Mechanism-by-mechanism map

| Codex mechanism | Evidence | Alchemy mapping |
|---|---|---|
| Idle-wake restart: `continue_if_idle` reads goal state, and if `Active`, calls `thread.try_start_turn_if_idle([continuation item])` | `codex:ext/goal/src/runtime.rs:359–415` | Ring DO edge-triggered dirty signal: wake → re-read ledger; if runnable-head empty ∧ run not halted → **admit a synthetic continuation stimulus** with deterministic delivery id `continuation:${session}:${iteration}` (idempotent; duplicate wakes collapse — "rows are truth, wakes are hints", §3.1) |
| Goal-state semaphore: permit held through the read/start window so external set/clear can't race the continuation launch | `runtime.rs:364–366` | free — DO single-threading + everything through the one inbox (Codex insight 4 says to state this explicitly; stated) |
| Rejected idle work is a debug no-op, not an error | `runtime.rs:394–400` | admission ledger dedupe by delivery id: re-admitting while running is a no-op row |
| Continuation template: evidence-audit exit ("The audit must prove completion, not merely fail to find obvious remaining work") | `codex:ext/goal/templates/goals/continuation.md:30–41` | the **default check policy** — when a charter has no `AI.check` ref, the kernel's default judge grades the halt condition with this audit (§2.5) |
| Exit = the model calls `update_goal { status }`; done-ness is a tool call, not prose | `codex:ext/goal/src/tool.rs:55–59` | **halt-as-tool** (§2.5): synthetic `resolve` tool whose input schema is `AI.until(schema)`'s schema; the check grades the call; schema-invalid bounces back as a tool error |
| 3-strikes `Blocked`: "same blocking condition … at least three consecutive goal turns"; never on first appearance; never merely-hard | `continuation.md:43–51` | `give_up` tool → **`Refused` claimed-then-ratified**: the kernel ratifies only when the same blocker is observed in ≥ N consecutive iteration Traces — `Refused { reason, observed }` already carries the count (`src/AI/Errors.ts:42–49`) |
| `restore_after_resume`: an `Active` goal on a resumed thread re-arms the loop | `runtime.rs:335–357` | Ring DO boot: recovery classification (§2.4 `Recovered`) → deliver last fold → if run not halted, set the dirty signal; the reducer re-admits the continuation |
| Budget: `BudgetLimited` is a status, not death; usage accounted under a permit with expected-goal-id CAS | `runtime.rs:431–461` | `BudgetExceeded` parks resumably with `resumeHint` (`src/AI/Errors.ts:17–28`); decrements commit in the same DO transaction as the fold write (§2.4), keyed `(ring, workItem)` — the CAS is the transaction |
| Mid-flight objective edit: `inject_if_running` steering | `runtime.rs:417–429` | `ProcessService.steer` — durable admission, promoted at the next iteration boundary (`src/AI/Process.ts:48–49`); never mid-turn (deliberately stricter than Codex, §2.1) |

### Default check/judge prompts as versioned kernel assets

Where they live — as **source constants**, not loose markdown (so they ship in the
bundle, get code-reviewed, and are importable by tests):

```
packages/alchemy/src/AI/prompts/
  continuation.ts      # the idle-wake continuation frame (objective-as-data, fidelity,
                       #   anti-goalpost-moving — continuation.md:1–28 analog)
  completionAudit.ts   # the default check policy (evidence bar — continuation.md:30–41)
  giveUpAudit.ts       # the Refused evidence bar (3-strikes — continuation.md:43–51)
  guardianPolicy.ts    # the Guardian system policy (guardian/policy_template.md analog)
  index.ts             # export const kernelAssets = { … } as const
                       #   + export const kernelAssetsHash: string
```

How `promptHash` covers them: the hash recorded on every event and fold snapshot
(`src/AI/Kernel.ts:42–43`, §3.1 plane 2) is computed over **the rendered term ++ the
kernel-asset digest**:

```ts
export const promptHash = (renderedTerm: string): string =>
  sha256(`${renderedTerm}\n--kernel-assets--\n${kernelAssetsHash}`)
```

so editing `completionAudit.ts` changes every dependent term's `promptHash`, which makes
recovered checkpoints created under the old audit **checkpoint fossils** that route to
the `Resume` policy instead of silently continuing (§9.3 durability doctrine) — the exact
property "version them like code" (Codex insight 5) demands. Regression tests: (a)
snapshot tests pinning `kernelAssetsHash` so a prompt edit is a visible diff + explicit
snapshot update; (b) graded fixture evals — recorded Traces where the correct verdict is
known (completion proven / completion claimed-but-unproven / blocker repeated ×3) run
through the default judge in CI.

---

## 5. Mid-turn compaction placement as ContextPolicy contract items

### The lore

Codex hard-codes: mid-turn compaction must place the summary **last** ("the model is
trained to see the compaction summary as the last item in history after mid-turn
compaction") with initial context re-injected **just above the last real user message**;
pre-turn/manual compaction clears the reference context so the next turn fully
re-injects (`codex:core/src/compact.rs:55–68`, the `InitialContextInjection` enum). This
is provider-coupled, version-drifting lore (their compaction is five files and counting)
— which is exactly why it must live in the harness's private `ContextPolicy` seam
(§2.6, §3.2), never in the Kernel interface. The design already requires the seam's
contract to include *placement*, not just *what to drop* (§3.2). Here is the seam
signature that delivers that, over verified `Prompt` structures:

```ts
// Cloudflare.AI.ContextPolicy (harness-private seam, §3.2) — proposed contract
export interface CompactionRequest {
  readonly phase: "preTurn" | "midTurn"       // CompactionPhase analog (turn.rs:156, :356)
  readonly reason: "contextLimit" | "explicit"
  /** The term-rendered region — OUTSIDE the policy's jurisdiction. Re-supplied from
      the immutable term on every call; guardrails can't be compacted away (§3.2). */
  readonly system: string
  /** The compactable region: Trace-derived, already pairing-repaired. */
  readonly history: Prompt.Prompt              // ai/Prompt.d.ts:1278–1284
  /** Environment baseline to re-inject (world-state analog, mapping 6). */
  readonly baseline: Prompt.Prompt
  readonly budget: { readonly used: number; readonly limit: number }
}

export class ContextPolicy extends Context.Tag("cf/ai/ContextPolicy")<ContextPolicy, {
  /** The policy owns BOTH selection and placement: it returns the fully-ordered
      replacement history. The kernel re-attaches `system` outside. */
  readonly compact: (req: CompactionRequest) => Effect.Effect<
    Prompt.Prompt,
    never,                                     // a broken policy degrades to truncate, never crashes the run
    LanguageModel.LanguageModel                // summarization is a model turn (compact.rs:91–121)
  >
}>() {}
```

And the default policies as data-flow over verified combinators — `Prompt.fromMessages`
(`ai/Prompt.d.ts:1401`), `Prompt.concat` (`:1466`), message construction (`:810–818`):

```ts
// truncate (default): pair-atomic, prompt-preserving — no model call, placement trivial
const truncate: ContextPolicy["Service"]["compact"] = (req) =>
  Effect.succeed(Prompt.fromMessages(
    ensureToolResultsPresent(dropOldestPairAtomic(req.history.content, req.budget)),
  ))

// codexStyle: summarize-and-place, encoding the mid-turn lore
const codexStyle: ContextPolicy["Service"]["compact"] = (req) =>
  Effect.gen(function* () {
    const summary = yield* LanguageModel.generateText({
      prompt: Prompt.concat(req.history, SUMMARIZATION_INSTRUCTION),
      toolChoice: "none",                      // ai/LanguageModel.d.ts:156
    })
    const summaryMsg = Prompt.makeMessage("assistant", {
      content: [Prompt.makePart("text", { text: summary.text })],
    })
    if (req.phase === "midTurn") {
      // summary LAST; baseline re-injected above the last real user message
      // (compact.rs:61–63 "BeforeLastUserMessage")
      const lastUser = findLastUserIndex(req.history.content)
      return Prompt.fromMessages([
        ...req.history.content.slice(0, lastUser).filter(keepAnchors),
        ...req.baseline.content,
        ...req.history.content.slice(lastUser).filter(keepAnchors),
        summaryMsg,                            // ← the trained-position invariant
      ])
    }
    // preTurn/manual: summary only; baseline cleared — next turn fully re-injects
    // (compact.rs:57–59 "DoNotInject")
    return Prompt.fromMessages([summaryMsg])
  })
```

Placement decisions never leak upward: the kernel's Stage-B pipeline is fixed
(`fold → render → repair → policy.compact when over budget → markCacheBoundaries →
CallModel`), and what changed inside `compact` is invisible to it. The compaction itself
is recorded as a durable `ContextCompacted` Trace event carrying the window-chain fields
(mapping 6), never as a second transcript.

One structural advantage worth stating (design §3.2 already claims it; the mapping
proves it): Codex needs `InitialContextInjection` machinery because its system context
lives *inside* the compactable history. Ours never enters `req.history` — `system` is
re-rendered from the immutable term every call — so the "re-inject initial context"
half of Codex's problem does not exist; only the summary-position half remains, and it's
three lines of the policy.

---

## 6. Rollout-file discipline → Trace writes on the Ring DO

### What Codex persists

`RolloutItem` (`codex:protocol/src/protocol.rs:3132–3145`) = `SessionMeta | ResponseItem
| InterAgentCommunication(+Metadata) | Compacted | TurnContext | WorldState | EventMsg`,
written as JSONL through a background writer where **items leave the pending queue only
after a successful write** (`codex:rollout/src/recorder.rs:1545–1549` per the study),
`TurnContextItem` persisted once per real user turn so resume recovers the durable
baseline (`protocol.rs:3204–3219`), `CompactedItem` carrying window-chain ids
(`protocol.rs:3166–3182`), and `WorldStateItem { full | patch }` snapshots
(`protocol.rs:3149–3163`). File creation is deferred until first persist.

### The mapping: plane-2 ordering

Our Trace **is** the rollout (one representation for folds, durability, observability,
autoresearch — §2.3, non-negotiable). The Ring DO discipline:

1. **All plane-2 writes for a boundary commit in one DO storage transaction**: Trace
   events + fold snapshot (with its `promptHash`) + budget decrement (§2.4, §3.1). This
   is stronger than Codex's pending-queue-retry — the DO transaction *is* the "leaves the
   queue only after successful write" guarantee.
2. **Terminal events are emitted only after the transaction commits.** `LoopHalted` (and
   the `dispatch` join resolution behind it) is ordered strictly after the plane-2 write
   that recorded the halt's evidence — the analog of Codex flushing the rollout before
   terminal events. Concretely: the reducer appends `{…events, foldSnapshot, halt}` in
   the txn, then publishes `LoopHalted` to the live stream and resolves waiters.
3. **Deferred creation**: the ring's storage rows are created lazily on first durable
   event (a triggered-but-immediately-refused admission leaves no fossil), mirroring
   `recorder.rs:744–748`.

### Which effect/ai Response parts become which durable events

The enumeration (completing mapping 1's emission table with the durability column and
the rollout-item correspondence):

| effect/ai part (verified) | KernelEvent | durable? | Codex rollout analog |
|---|---|---|---|
| `text-start/-delta/-end`, `reasoning-start/-delta/-end` (`ai/Response.d.ts:310–460, :514–660`) | `ModelDelta` | **no** — live-only, never advances the cursor (§2.3) | not persisted (deltas are EQ-only) |
| folded final `TextPart` / `ReasoningPart` (`:264, :468`) | inside `ModelCompleted.payload` | yes | `ResponseItem::Message` |
| `tool-call` (`:863`) | `ToolRequested` (pre-gate, normative order §2.3) | yes | `ResponseItem::FunctionCall` |
| `tool-result` final (`:944–1049`, `preliminary: false`) | `ToolCompleted` / `ToolFailed` (by `isFailure`) — plus the distinct `ToolDenied` terminal when the gate blocked it | yes | `ResponseItem::FunctionCallOutput` |
| `tool-result` preliminary (`:975`) | `ToolProgress` | **no** | not persisted |
| `tool-approval-request` (`:1164`) | `Escalated` (Ask issued) | yes | approval request EventMsg |
| `response-metadata` (`:1548`) | `ModelResponseId` — the provider `responseId` bookmark | yes | the `response_id` bookmark (protocol_v1.md:45) |
| `finish` (`:1739`: `reason` + `Usage` with cache splits `:1655–1707`) | `ModelCompleted` (usage feeds the transactional budget decrement) | yes | turn-completion EventMsg + token accounting |
| `error` (`:1826`) | `ModelFailed` | yes | error EventMsg |
| `source` / `file` (`:1300, :1240`) | `ModelCompleted.payload` attachments | yes | citation/attachment items |

Plus the three rollout item classes that have no Response-part origin, mapped to
kernel-emitted durable events:

- `TurnContextItem` → **`TurnStarted` payload**: model slug, `promptHash`, policy
  profile, environment baseline ref — persisted once per turn so recovery rebuilds the
  baseline without replaying the world (Codex insight 13).
- `CompactedItem` → **`ContextCompacted`** durable event carrying
  `{ windowNumber, windowId, previousWindowId, firstKeptEventSeq }` — window chaining
  from day one (Codex retrofitted these as `Option`al fields; we ship them required).
- `WorldStateItem` → **`BaselineSnapshot { full | patch }`** event class, referenced by
  `TurnStarted` — named in the schema from v1 per §9.3's "cheap now, painful to
  retrofit".

**What we deliberately do not use**: `Chat` / `Chat.Persisted`
(`ai/Chat.d.ts:49–300, :483–579`) as a durable store — `Chat.history` is a
`Ref<Prompt.Prompt>` (`ai/Chat.d.ts:89`) and its persistence layer is a second
transcript by construction, violating the one-representation rule. The Trace is truth;
the `Prompt` is **derived** (fold → repair → render). `Chat.export`'s serialization
trick is still useful — `Prompt` has a full `Schema.Codec<Prompt, PromptEncoded>`
(`ai/Prompt.d.ts:1303`) — for carrying the candidate transcript inside serializable
`StepState` (§2.2 Stage B note), which `structuredClone`-survives by construction.

The `ModelResponseId` bookmark deserves a note: effect/ai supports incremental provider
calls via `ResponseIdTracker` (`previousResponseId` + `incrementalPrompt` in
`ProviderOptions`, `ai/LanguageModel.d.ts:440–444`), but the tracker keys on **prompt
message object identity** (`markParts(parts: ReadonlyArray<object>, responseId)`,
`ai/ResponseIdTracker.d.ts:46–50`) — identity that does not survive a rebuild from the
Trace. Persisting the bookmark keeps server-side continuation *possible* after recovery
(re-mark the rebuilt prefix), but this is a gap (mapping 8, gap 4).

---

## 7. Steering rejection vocabulary

Codex rejects steering with typed reasons (`codex:core/src/session/mod.rs:246–283`):
`NoActiveTurn(Vec<UserInput>)` — note it **returns the input to the caller** —
`ExpectedTurnMismatch { expected, actual }`, `ActiveTurnNotSteerable { turn_kind:
Review | Compact }`, `EmptyInput`. Our analogs, as the typed error union for
`ProcessService.steer` under `AI.concurrency > 1` (the Phase-2 run-key typing promised
in `src/AI/Process.ts:23–27` and §2.1):

```ts
// src/AI/Errors.ts additions (proposed)

/** Steering arrived with no admissible target run. Carries the input back so the
    caller can re-route it as a dispatch (Codex NoActiveTurn(Vec<UserInput>) analog) —
    though the DEFAULT policy is hold-not-reject: unrelated input during a pending run
    parks in the inbox (§2.4 Ask doctrine). This error fires only for steer-explicit
    surfaces that demand immediate resolution. */
export class NoActiveRun extends Data.TaggedError("AI.NoActiveRun")<{
  readonly ring: string
  readonly input: unknown
}> {}

/** The caller targeted a specific run (by work-item key) that is not the active one —
    the run it saw has since halted or been superseded (ExpectedTurnMismatch analog).
    Prevents cross-run contamination under concurrency. */
export class RunMismatch extends Data.TaggedError("AI.RunMismatch")<{
  readonly ring: string
  readonly expected: string   // run key the steer targeted
  readonly actual: string     // run key currently active
}> {}

/** The target run exists but is inside a non-steerable positional activity. Check and
    Fold are the kernel's positional arrows — parties other than the kernel may not
    steer a verdict or a checkpoint in progress (our review/compact analog, §9.3).
    The steer is HELD and promoted at the next boundary; this error is only surfaced
    to callers who requested fail-fast semantics. */
export class NonSteerableActivity extends Data.TaggedError("AI.NonSteerableActivity")<{
  readonly ring: string
  readonly runKey: string
  readonly activity: "check" | "fold" | "compaction" | "recovery"
}> {}

/** Concurrency > 1 and the steer named no run key: no deterministic target exists.
    (Codex never hits this — one task per session; our rings multiplex.) */
export class AmbiguousRun extends Data.TaggedError("AI.AmbiguousRun")<{
  readonly ring: string
  readonly candidates: ReadonlyArray<string>
}> {}

/** EmptyInput analog — rejected at admission, nothing durable written. */
export class EmptySteer extends Data.TaggedError("AI.EmptySteer")<{
  readonly ring: string
}> {}

export type SteerError =
  | NoActiveRun | RunMismatch | NonSteerableActivity | AmbiguousRun | EmptySteer
```

And the Phase-2 handle refinement:

```ts
// ProcessService (Phase 2) — steer grows a run key and the typed union
steer(input: unknown, runKey?: string): Effect.Effect<void, SteerError, RuntimeContext>
```

Semantics that differ from Codex, deliberately: (a) delivery is at the **iteration
boundary**, never mid-turn (`src/AI/Process.ts:23–26`; Codex drains mid-turn at the top
of each sampling iteration, `codex:core/src/session/turn.rs:229–233`, and even defers
the drain after auto-compact so the model resumes its continuation before seeing the
steer, `turn.rs:219–222` — placement lore we don't need because our boundary is
coarser); (b) `NoActiveRun` and `NonSteerableActivity` default to **hold**, not reject —
rejection is opt-in for interactive surfaces, because the Ask doctrine (§2.4) says
unrelated input during a pending wait is held, never dropped. The error union exists so
that the *fail-fast* mode is typed, not so that steering is fragile by default.

Steer admission is a ledger row like everything else (delivery-id idempotent), so a
retried steer never double-delivers — the property Codex gets from SQ ordering.

---

## 8. The gap ledger

### What Codex has that effect/ai + our design cannot yet express

1. **Prompt-cache-stable item identity.** Codex's Responses items carry provider item
   ids, and the synthetic-fill UUIDv5 namespace exists to keep *model-visible ids* stable
   across repairs (`normalize.rs:14–15`). effect/ai `Prompt.Message` has **no id at all**
   (verified: `ai/Prompt.d.ts:763–773` — role + options only); cache alignment is purely
   structural. Our repair pass is deterministic by construction (mapping 2), but we
   cannot express "this exact item, by id, was already in the provider's cache" — cache
   boundary marking is limited to provider options / message ordering.
2. **Sticky, resumable model streams.** Codex's `ModelClientSession` caches WebSocket +
   sticky routing state across retries within a turn (`turn.rs:217–218`).
   `LanguageModel.streamText` is a fresh `Stream` per call
   (`ai/LanguageModel.d.ts:73–85`); there is no session/affinity handle. Mid-stream
   eviction recovery therefore re-issues the whole sampling request (resume + repair
   tier, not stream-resume).
3. **Context-capable `needsApproval`.** `NeedsApprovalFunction` returns
   `Effect.Effect<boolean>` with `R = never` (`ai/Tool.d.ts:120`) — the gate cannot
   resolve services (our ring policy state, amendment cache) from ambient context;
   everything must be closed over at Stage-A link time. Workable (mapping 3) but rules
   out per-call context refinement without re-linking. An upstream widening to
   `Effect<boolean, never, R>` would dissolve this.
4. **Serializable response-id tracking.** `ResponseIdTracker.markParts` keys on message
   **object identity** (`ai/ResponseIdTracker.d.ts:46–50`), which cannot survive
   Trace-rebuilds across DO eviction — `previousResponseId`/`incrementalPrompt`
   (`ai/LanguageModel.d.ts:440–444`) optimization silently degrades to full-prompt sends
   after recovery. We persist the `ModelResponseId` bookmark (mapping 6) so a harness
   *could* re-mark a structurally-rebuilt prefix, but that is a workaround, not a
   contract.
5. **Two-phase tool cancellation with ownership handoff.** Codex distinguishes tools
   that "wait for runtime cancellation" (PTY teardown owns the terminal outcome) from
   hard-aborts with synthesized "aborted after Xs" responses
   (`codex:core/src/tools/parallel.rs:158–199` per the study). Effect interruption +
   `Scope` can express this (uninterruptible finalizer regions), but effect/ai's
   `Toolkit.handle` (`ai/Toolkit.d.ts:147–155`) offers no cancellation-negotiation
   surface — the pattern is ours to build in the Stage-B scheduler.
6. **Per-tool parallelism metadata → scheduler.** Codex's read/write-lock model
   (`supports_parallel_tool_calls`) has the raw material in effect/ai —
   `Tool.Readonly` / `Destructive` / `Idempotent` / `OpenWorld` annotations
   (`ai/Tool.d.ts:1248–1313`) — but `GenerateTextOptions.concurrency`
   (`ai/LanguageModel.d.ts:162`) is a single knob applied to auto-resolution. Since we
   drive with `disableToolCallResolution: true`, the RW-lock scheduler (readonly ⇒ read
   lock, else write lock) is Stage-B code we write; effect/ai just carries the bits.
7. **Per-request provider metadata.** Codex rides turn metadata on HTTP headers
   (`X-Codex-Turn-Metadata`). `ProviderOptions` exposes a `span` and the normalized
   request only (`ai/LanguageModel.d.ts:390–445`); arbitrary per-call metadata needs
   provider-specific `ProviderOptions`-record augmentation (`ai/Prompt.d.ts:16–24`) —
   possible per message, awkward per request.
8. **Pre-sampling token status with cache-prefix scope.** Codex computes
   `BodyAfterPrefix` token status (tokens after the stable prefix) before deciding to
   compact (`turn.rs:304–331, :908–920` region). effect/ai has a `Tokenizer` service
   (`ai/Tokenizer.d.ts`) but no cache-prefix-aware accounting; usage arrives only
   *after* the response in `FinishPart.usage`. Pre-emptive compaction thresholds are
   estimate-based on our side (Codex has the same TODO — `turn.rs:152–155`).
9. **Remote/server-side compaction.** `compact_remote_v2` delegates summarization to the
   provider. No effect/ai surface; our `ContextPolicy.compact` is always a client-side
   model turn (an acceptable cost — it keeps the seam provider-neutral).

### What our typed layer graph eliminates that Codex needs runtime machinery for

1. **The `Granular` approval config and the seven-plus ask channels.** Codex needed
   per-category runtime booleans (`GranularApprovalConfig`,
   `codex:protocol/src/protocol.rs:939–954`) because every approval surface grew its own
   Op/Event pair. We have one `Ask` protocol with payload kinds (mapping 3), and — the
   stronger claim — **capability denial by omission**: a charter that never interpolates
   `${Approve}` has no approval surface anywhere in its Layer graph's requirements
   (`src/AI/Loop.ts:106–109`). The runtime toggle becomes a compile-time absence.
2. **Roles as config layers.** Codex differentiates subagents by stacking TOML config
   layers at spawn (`codex:core/src/agent/role.rs`). Our per-term Layer graphs
   (`AI.layer(Engineer).pipe(Layer.provide(BashDevBox))` vs `Layer.provide(BashOverlay)`,
   `src/AI/Kernel.ts:132–139`) are the statically-typed form — same contract, different
   physics, verified by `tsc` instead of config discipline.
3. **Tool exposure filtering and depth caps.** Codex filters MCP tool exposure and
   enforces spawn-depth limits in a registry (`AgentRegistry`,
   `codex:core/src/agent/registry.rs:71–87`). Our toolkit is *compiled from the term's
   refs* at Stage A — a tool absent from the charter is absent from the `Toolkit.make`
   call (`ai/Toolkit.d.ts:212`), not filtered at runtime; delegation depth is Layer
   graph depth, visible in types.
4. **The goal-state semaphore and the config lock.** `continue_if_idle` holds a permit
   through its read/start window (`runtime.rs:364–366`); `config_lock.rs` serializes
   settings. The Ring DO's single thread + one ordered inbox is that lock, globally, for
   free (mapping 4).
5. **State split three ways.** Rollout JSONL + SQLite state DB + thread-store, bridged
   (`state_db_bridge.rs`), reconciled on resume. One Trace + fold in one DO transaction
   (plane 2) — goals (our halt/check state), history, and budgets are rows in the same
   store with the same cursor.
6. **The hooks engine.** `HookHandlerType = Command | Prompt | Agent` with ten event
   names (`codex:protocol/src/protocol.rs:1483–1502`) is a closed vocabulary grown one
   variant per need (§9.5 explicitly rejects this shape). Stop-hooks-that-block-exit are
   our `Check` verdict (`off-goal` feedback re-enters the loop,
   `src/AI/Check.ts:4–22`); pre-tool-use hooks are the `ToolInterceptor` seam (§3.2);
   pre/post-compact is inside `ContextPolicy`; every one is a typed Layer substitution,
   not a registered callback.
7. **The Session god object.** 4,081 lines, 200 imports, 11k lines of tests
   (`designs/ai/reports/codex.md` §Judgments) — the price of a kernel that knows the
   words memory, compaction, sandbox, review, goals, guardian, skills. Our Kernel
   interface has three members (`src/AI/Kernel.ts:102–118`) and no component vocabulary;
   each Codex subsystem lands as a private harness seam or a Layer, discoverable only by
   reading which tags a `Layer.effect` pulls (§3.2).

---

## Implementation order (feeding the Phase-2 kernel and `CloudflareAgent.test.ts`)

Ordered by dependency, each item independently testable; 1–3 are pure and land without
any provider:

1. **`src/AI/Ids.ts`** — `commandId` / `eventId` derivation + the deterministic
   `IdGenerator.Service` (mapping 1). Pure; property test: replay of the same
   `(session, stepIndex)` sequence yields identical ids.
2. **`src/AI/Pairing.ts`** — `ensureToolResultsPresent` over `Prompt.Message` + the
   orphan-result trim (mapping 2). Pure; the four property tests (well-paired,
   idempotent, deterministic, trim-composing).
3. **Step machine hardening (`src/AI/Kernel.ts` / new `src/AI/Step.ts`)** — `Command` /
   `Feedback` with ids; the truncated-batch rule in `ModelResponse` handling; the
   Response-part → KernelEvent mapping table as a total function (mapping 6's table).
   Conformance test: every `StepState` survives `structuredClone` (uses the
   `Prompt` Schema codec, `ai/Prompt.d.ts:1303`).
4. **Stage-B turn driver (memory kernel)** — `streamText` +
   `disableToolCallResolution: true`, emission points (mapping 1), our RW-lock tool
   scheduler off `Tool.Readonly`/`Destructive` annotations, `ToolInterceptor`
   pass-through, transactional budget decrement off `FinishPart.usage`.
5. **Ask protocol (`src/AI/Ask.ts`)** — payload/answer/amendment schemas (mapping 3),
   the `Escalated`-park / `tool-approval-response`-resume path, `PolicyAmended` fold
   state; plus the `SteerError` union on `ProcessService.steer` (mapping 7).
6. **Stage-C loop runtime** — idle-wake continuation admission, halt-as-tool
   (`resolve` / `give_up`), N-consecutive `Refused` ratification, and
   **`src/AI/prompts/`** with `kernelAssetsHash` folded into `promptHash` + snapshot
   tests (mapping 4).
7. **`ContextPolicy` seam + `truncate` default** — the placement-owning contract
   (mapping 5); the codex-style summarizing policy ships as the second implementation
   and the seam's proof.
8. **`ApproveGuardian` layer** — `generateObject` judge, fail-closed timeout, denial
   circuit breaker (mapping 3). The flagship "autonomy is a Layer choice" demo; tests
   run against the memory kernel with a scripted `LanguageModel`.
9. **`CloudflareAgent.test.ts`** — the Ring DO fixture
   (`test/AI/fixtures/org/cloudflare/kernel.ts` grown from mock to Phase-2-backed):
   admit (idempotent by delivery id) → dispatch → Stage-B turn with one gated tool →
   `Escalated` park → answer-with-amendment (verify `PolicyAmended` in the Trace and
   that the *second* identical call skips the ask) → steer during check
   (assert hold-then-promote, and `RunMismatch` on a stale run key) → halt →
   assert `LoopHalted` is sequenced after the plane-2 commit and that
   `trace(ring, after)` replays to an identical fold. Kill-and-recover variant: evict
   mid-turn, assert repair-on-read produced the synthetic `aborted` results and the
   `Resume` policy saw the `promptHash` fossil check.

The conformance suite items 1–3 seed are the same tests §2.6 promises to run verbatim
against the Cloudflare harness in Phase 3 — Codex's "resume + normalize at massive
scale" is the floor tier of that suite (§9.3), and this mapping is the evidence the
floor is reachable with the APIs effect/ai ships today.
