# Mapping pi/Flue loop mechanics onto effect/ai for the Alchemy AI Kernel

Design-research report. Question: how do the loop mechanics of **pi** (`.vendor/pi/packages/agent` — the ~790-line `agent-loop.ts`, the `Agent` wrapper, the 9-hook `AgentLoopConfig`) and **Flue** (`.vendor/flue/packages/runtime` — the journaling/result-tools/compaction wrapper around pi's loop) map onto **effect v4's `effect/unstable/ai` modules** inside our Kernel architecture (design doc §2.2/§2.4/§2.5/§9.3, `src/AI/Kernel.ts`, `src/AI/Process.ts`)?

Every effect/ai API cited below was verified against the `.d.ts` files in `node_modules/effect/dist/unstable/ai/` (and, where types were ambiguous, the `.js`). Citations are `file:line` into those files unless prefixed with a vendor path.

---

## 0. The one load-bearing behavioral fact (verified in the .js)

**One `LanguageModel.streamText` call = one provider request = one pi turn** (one assistant message and, if resolution is enabled, its tool results). It does **not** loop back to the model:

- `streamContent` makes a single provider stream call (`streamWithNonIncrementalFallback()`, `LanguageModel.js:530-541`), forks a handler fiber per `tool-call` part **as parts arrive** (`LanguageModel.js:747-750` → `handleToolCall`, `:700-723`), defers `finish` parts until all handlers settle (`:733-756`), ends the queue, and is done. The turn→turn iteration (pi's inner `while`) is the **caller's** job — exactly what our §2.4 step machine is.

- Corollary that decides question 3: with auto-resolution, tool execution **starts before the finish reason is known** (`tool-call` parts are forked at `:747-750`; the `finish` part carrying `reason: "length"` arrives later). Pi's truncated-arguments-fail-the-batch rule (`.vendor/pi/packages/agent/src/agent-loop.ts:207-216`, design §2.4's pairing invariant) is therefore **unimplementable under effect/ai auto-resolution**. We must run with `disableToolCallResolution: true` (`LanguageModel.d.ts:164-172`) and execute tools from our command interpreter via `Toolkit.WithHandler.handle` (`Toolkit.d.ts:147-155`).

---

## 1. Pi's nine hooks → our architecture (the table)

Pi's `AgentLoopConfig` (`.vendor/pi/packages/agent/src/types.ts:140-282`) is the empirically-minimal seam set of a production harness. Where each responsibility lands:

| # | pi hook | Responsibility | Lands in | Concrete mechanism |
|---|---------|----------------|----------|--------------------|
| 1 | `convertToLlm` (types.ts:169) | lossy projection harness-transcript → provider messages | **split: renderer (ours) + effect/ai provider Layer** | Ours: pure fold Trace → `Prompt.Prompt` via `Prompt.make`/`fromMessages` (Prompt.d.ts:1377, 1401), with **repair-on-read** (pairing normalization) composed in. effect/ai's: `Prompt.Prompt` → wire format happens inside the provider Layer (`LanguageModel.make` hands providers a normalized `ProviderOptions.prompt`, LanguageModel.d.ts:390-445). Pi's two-stage split (`transformContext` → `convertToLlm`) survives as ContextPolicy → renderer → provider; a memory policy can never touch the provider payload. |
| 2 | `transformContext` (types.ts:191) | context rewrite before each model call (compaction/injection point) | **ContextPolicy seam** (kernel-internal service, §2.6) | `prepare` is pure over `Prompt.Prompt`; applied by the interpreter before every `CallModel`. Summarize is a separate command (see §6 below). Never a step-machine concern beyond "the prompt in `CallModel` is already policy-applied". |
| 3 | `getApiKey` (types.ts:201) | per-call credential resolution (expiring OAuth) | **dissolves into the provider Layer** | effect/ai providers are Layers over their own config/HttpClient; token refresh is Layer-internal. The Kernel never sees credentials — no seam needed. (Pi needed the hook only because its loop called `streamSimple` directly.) |
| 4 | `shouldStopAfterTurn` (types.ts:213) | graceful stop policy after a turn | **step machine** (§2.4: "termination is policy") | A pure predicate in `step` over `StepState` (budget counters, phase) evaluated on the `ModelResponse` feedback; emits `Halt`. Budget ceilings can additionally fire between any two commands (per-command accounting) — strictly stronger than pi's per-turn check (pi #4325). |
| 5 | `prepareNextTurn` (types.ts:220) | swap context/model/thinking between turns | **step machine data + Layer** | `CallModel` carries the model choice as per-turn data (§9.3). Interpreter satisfies it via `Effect.provideService(LanguageModel.LanguageModel, impl)` per command, or a `Model.make` Layer (`Model.d.ts:30, 104` — a `Model` *is* a `Layer<LanguageModel | ProviderName | ModelName>`). Context swap = the prompt in the next `CallModel` (already covered by 1+2). |
| 6 | `getSteeringMessages` (types.ts:235) | mid-run input, delivered after the current turn's tool batch | **admission inbox (harness) + `Steered` feedback (step machine)** | One durable, ordered, idempotent inbox (§2.5); the interpreter drains it at the **turn boundary** (after the last `ToolResult` of the batch, before the next `CallModel`) and feeds `Steered{items}`. Delivery point spec in §2 below. |
| 7 | `getFollowUpMessages` (types.ts:248) | input delivered only when the agent would stop | **same inbox, second drain point** | Drained when `step` reaches `WouldStop`; a non-empty drain cancels the halt and re-enters the turn loop (resets the step allowance). Pi's two queues become **one inbox with two drain points** — delivery class is *when it's drained*, not a second mechanism. |
| 8 | `beforeToolCall` (types.ts:267) | block/allow (permission seam) | **ToolInterceptor seam (§9.3) in the command interpreter; approval subset = effect/ai `needsApproval`** | Since we execute tools ourselves, the interceptor sits between the `CallTool` command and `toolkit.handle`; a block synthesizes the paired error `ToolResult` (pairing invariant). effect/ai natively covers the ask-a-human subset: `Tool.make(..., { needsApproval })` (Tool.d.ts:104-133, 854) emits `tool-approval-request` parts (Response.d.ts:1164-1173) instead of executing, and on the next call pre-resolves `tool-approval-response` prompt parts (Prompt.d.ts:599-612), executing approved calls and synthesizing **model-visible denial results** (`createDenialResults`, LanguageModel.js:628-651, 1005+) — our Ask verdict semantics, shipped. |
| 9 | `afterToolCall` (types.ts:281) | rewrite tool results; `terminate` early-exit hint | **Layer substitution (handler wrapping) + step machine** | Handlers are ordinary Effects provided via `Toolkit.toLayer`/`toHandlers` (Toolkit.d.ts:55-64); "rewrite the result" = wrap the handler in its Layer — composition, not mutation (§9.5). The `terminate: true` hint (pi types.ts:77-86; Flue's result tools set it, `.vendor/flue/packages/runtime/src/result.ts:171-173`) needs no analogue: with halt-as-tool, termination is signaled by *which tool was called* — `step` sees the `resolve`/`give_up` `ToolResult` feedback and emits `Halt`. |

Verdict on the hypothesis (§2.2): the 9 hooks partition cleanly into (a) subsumed by effect/ai (3, half of 1, the approval half of 8), (b) our step machine (4, 5-data, 9-terminate), (c) our two named seams — ContextPolicy (2) and ToolInterceptor (8) — and (d) the admission inbox (6, 7). Nothing needs a new term kind and nothing needs a closed hook vocabulary.

---

## 2. Pi's two delivery points as step-machine states + commands

Pi's precise semantics (verified, `.vendor/pi/packages/agent/src/agent-loop.ts`): steering never interrupts tools; the steer queue is polled after the turn's full tool batch (`:259`), the follow-up queue only at would-stop (`:263`); queued items are injected as messages before the next model call (`:182-189`). Flue adds: the queues must be durable (pi's are in-memory arrays and die with the process — pi study §2.5).

Our mapping — one durable inbox, two drain points, three feedbacks:

```ts
// ── StepState (serializable; survives structuredClone — §2.4 purity checklist)
interface StepState {
  readonly transcript: ReadonlyArray<Prompt.MessageEncoded> // Prompt.d.ts:1255 — the ENCODED union, JSON-safe
  readonly phase: Phase
  readonly budget: BudgetState                              // per-command counters
  readonly nagsRemaining: number                            // §4 below
  readonly pendingHalt: unknown | undefined                 // validated `resolve` payload awaiting check
}

type Phase =
  | { readonly _tag: "AwaitingModel"; readonly turn: number }
  | { readonly _tag: "AwaitingTools"; readonly turn: number
      readonly pending: ReadonlyArray<string> }             // callIds — pairing keys, never tool names
  | { readonly _tag: "Boundary";  readonly turn: number }   // drain point 1 (pi :259)
  | { readonly _tag: "WouldStop"; readonly turn: number }   // drain point 2 (pi :263)
  | { readonly _tag: "Halted" }

// ── Feedback (extends §2.4's set; ids arrive in feedback, never minted in step)
type Feedback =
  | { readonly _tag: "ModelResponse"; readonly parts: ReadonlyArray<Response.AnyPartEncoded> } // Response.d.ts:38
  | { readonly _tag: "ToolResult"; readonly callId: string; readonly name: string
      readonly isFailure: boolean; readonly encodedResult: unknown }
  | { readonly _tag: "Steered"; readonly items: ReadonlyArray<Prompt.MessageEncoded> }         // non-empty drain
  | { readonly _tag: "InboxEmpty" }                                                            // empty drain
  | { readonly _tag: "AskAnswer"; /* … */ }
  | { readonly _tag: "Recovered"; /* Flue classification — §9.3 */ }

// ── The transitions that implement both delivery points
declare const step: (s: StepState, fb: Feedback) => readonly [StepState, ReadonlyArray<Command>]
// (AwaitingModel, ModelResponse):
//   finish.reason === "length" && toolCalls.length > 0
//     → append synthetic error ToolResults for EVERY call (salvage-parse guard, pi :207-216);
//       phase := Boundary; commands: [Emit(ToolFailed)×n]           // pairing filled without CallTool
//   toolCalls.length > 0
//     → phase := AwaitingTools{pending: callIds}; commands: [Emit(ToolRequested)×n, CallTool×n]
//   no tool calls
//     → bounded halt & no pendingHalt → nag or WouldStop (§4); else phase := WouldStop; commands: []
// (AwaitingTools, ToolResult):
//   pending := pending \ {callId}; append tool message part to transcript
//   pending = ∅ → phase := Boundary; commands: []                    // interpreter now drains the inbox
// (Boundary, Steered{items}):     ← pi's getSteeringMessages point
//   append items as user messages; RESET step allowance (§9.3); phase := AwaitingModel{turn+1}
//   commands: [CallModel{prompt: render(transcript), …}]
// (Boundary, InboxEmpty):
//   phase := AwaitingModel{turn+1}; commands: [CallModel{…}]         // pi: inner while continues on tool calls
//   — or, if the last ModelResponse had no tool calls, phase := WouldStop; commands: []
// (WouldStop, Steered{items}):    ← pi's getFollowUpMessages point
//   same as Boundary/Steered — cancel the stop, re-enter
// (WouldStop, InboxEmpty):
//   run check/fold at this boundary (§2.5), then commands: [Checkpoint, Halt{result: pendingHalt}]
```

The interpreter's contract (the impure half):

1. `CallModel` → `LanguageModel.streamText({ prompt, toolkit, toolChoice, disableToolCallResolution: true })` (`LanguageModel.d.ts:592-604`, options `:131-173`); run the stream, journal parts (§5), accumulate into one `ModelResponse` feedback.
2. `CallTool` → ToolInterceptor gate → `toolkit.handle(name, params)` (`Toolkit.d.ts:147-155`) → take the last non-preliminary `Tool.HandlerResult` (`Tool.d.ts:714-735`) → `ToolResult` feedback. Pi's parallel-with-order-stability batch (`agent-loop.ts:491-556`) is `Effect.forEach(batch, run, { concurrency })` with results delivered in source order.
3. **Between** the last `ToolResult` of a batch and the next feedback, drain the admission inbox once; feed `Steered` or `InboxEmpty`. Same at `WouldStop`. Never mid-batch — the pairing invariant requires every `CallTool` answered first (this is also exactly pi's guarantee: "tool calls from the current assistant message are not skipped", types.ts:229).
4. `ProcessService.steer(input)` (`src/AI/Process.ts:49`) = durable enqueue into that inbox — the harness owns queue semantics (dedupe by delivery id, FIFO head), the step machine owns only the two consumption points. Flue's plane-1 submission store is the durable reference implementation (idempotent admission, per-session FIFO — flue study §2.5).

---

## 3. Turn structure: who executes tools, and why

**Does one `streamText` call = one pi turn?** Yes — verified in §0. effect/ai gives the *turn primitive*; it deliberately does not give the *loop*. (Its `generateText` with auto-resolution likewise appends resolved tool results to the returned content, `LanguageModel.js:514-525` — still one round, no loop-back.)

**Who executes tools — effect/ai's resolver or our command interpreter?** Our interpreter, via `disableToolCallResolution: true`. Justification, in decreasing order of force:

1. **The salvage-parse guard is otherwise impossible.** Auto-resolution forks handlers per `tool-call` part as it streams (`LanguageModel.js:747-750`), before the `finish` part reveals `reason: "length"` (`Response.d.ts:1632-1641`). Pi fails the whole batch on `length` because streamed args are salvage-parsed and may validate while incomplete (`agent-loop.ts:207-216, 383-408`). Only a caller that sees the complete part list before executing anything can enforce this.
2. **The step machine owns Commands** (§2.4 normative). Budget decrements are per-`CallTool` and transactional with the Trace write; ToolInterceptor gates sit before execution; blocked/denied calls synthesize model-visible results. All of that lives between "model asked" and "handler ran" — a space that auto-resolution closes.
3. **Durable parking.** An `Ask` (approval) must park the run durably (a DO can persist the pending `CallTool` and hibernate). effect/ai's in-flight `FiberSet` of tool handlers dies with the process; its approval flow assumes the caller re-invokes with `tool-approval-response` parts in the prompt — usable, but the *waiting* is ours either way.
4. **Interruption settlement.** On eviction, in-flight calls must settle as typed interrupted results (Flue's terminalization; §9.3). We can only settle what we dispatched.
5. The types cooperate: with `disableToolCallResolution: true`, `ExtractServices<Options> = never` (`LanguageModel.d.ts:373-377`) and handler errors leave the stream's error channel (`ExtractError`, `:342, 355-362`) — handler services and failures move to *our* `toolkit.handle` call sites, which is where per-term tool Layers are in scope.

What we keep from effect/ai even in this mode: the toolkit still travels in the request so the provider sees the tool schemas (`GenerateTextOptions.toolkit`, `LanguageModel.d.ts:131-140` — the documented purpose of the flag, `:164-172`); `toolChoice` still steers the model (`:156-158`, union at `:212-217`); parameter validation + result encoding still happen inside `toolkit.handle` (`Toolkit.d.ts:141-155`); a schema-invalid call surfaces as `AiError` which we convert to an error `ToolResult` the model can self-correct on — Flue's bounce-back for free (`result.ts:220-226` hand-rolls this).

Turn shape in transcript terms: the collected stream parts of one call fold into one assistant message + one tool message via `Prompt.fromResponseParts` (`Prompt.d.ts:1441` — "folding completed text and reasoning streams into assistant parts, placing tool calls … in an assistant message, and placing non-preliminary tool results in a tool message"). Since we execute tools ourselves we build the tool message from our own results with `Prompt.makePart("tool-result", { id, name, isFailure, result })` (`Prompt.d.ts:492-509, 564`) and append via `Prompt.concat` (`:1466-1517`). One pi turn ≙ `[AssistantMessage, ToolMessage]` (`Prompt.d.ts:1066-1078, 1182-1194`).

---

## 4. Flue's `finish`/`give_up` → our halt-as-tool (`resolve`/`give_up`)

Flue's mechanics (`.vendor/flue/packages/runtime/src/result.ts`): `finish` parameters derived from the result schema (non-object schemas wrapped in `{ result: … }`, `:179-188`); validation failure **throws** → tool-error the model corrects (`:220-226`); first success wins, later calls get an "already done" error result (`:355-371`); success sets `terminate: true` (`:229-233`); a turn ending with neither tool gets a reminder prompt, capped at `MAX_FOLLOWUPS = 32` (`session.ts:3545-3568`); `give_up` → typed `ResultUnavailableError{reason, assistantText}` (`result.ts:380-388`).

Our sketch, using only verified APIs:

```ts
import * as Schema from "effect/Schema"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import type { Halt } from "../Halt.ts"

// Stage A (link): derive the halt toolkit from the AI.until ref.
// Tool.dynamic exists precisely for runtime schemas (Tool.d.ts:905-971) —
// "tools whose schema is known only at runtime", which is what a term is.
const makeHaltToolkit = (halt: Halt<any, any>) => {
  const resolve = Tool.dynamic("resolve", {
    description:
      "Call when the halt condition is met. Arguments are validated against " +
      "the required schema; on validation failure you receive an error and may retry.",
    // Halt.schema is S.Top | undefined (src/AI/Halt.ts:37); Tool.dynamic wants
    // Schema.Constraint | JsonSchema (Tool.d.ts:950-960). AI.until(schema) should
    // be constrained to Schema.Constraint at the term level — flagged in §7.
    parameters: halt.schema ?? Schema.Struct({}),
    success: Schema.String,
  })
  const giveUp = Tool.dynamic("give_up", {
    description:
      "Call only if the goal is unachievable. Provide the blocker and the " +
      "evidence observed across attempts. This ends the run as a typed refusal.",
    parameters: Schema.Struct({
      reason: Schema.String,
      evidence: Schema.optional(Schema.Array(Schema.String)), // Refused's evidence bar (§9.3 / Errors.ts:42-49)
    }),
    success: Schema.String,
  })
  return Toolkit.merge(userToolkit, Toolkit.make(resolve, giveUp)) // Toolkit.d.ts:212, 270-274
}

// Handlers are pure acknowledgements — the *step machine* interprets the call:
haltToolkit.toLayer({                                             // Toolkit.d.ts:60-64
  resolve: () => Effect.succeed("Result accepted."),
  give_up: () => Effect.succeed("Acknowledged."),
})
```

Step-machine logic (all pure):

- **Validation bounce**: interpreter runs `toolkit.handle("resolve", params)`; schema failure → error `ToolResult` (isFailure) → the model self-corrects next turn. (Flue's throw-inside-execute, natively.)
- **First-call-wins**: if `pendingHalt !== undefined` and another `resolve`/`give_up` arrives, `step` synthesizes an "already done" error result *without* emitting `CallTool` — pairing preserved, no re-execution (Flue `result.ts:355-371`).
- **Success**: `ToolResult{name: "resolve"}` → `pendingHalt := params`; at the next `WouldStop`/`InboxEmpty` boundary the **check** grades it (§2.5 four-valued verdict); goal-met → `[Checkpoint, Halt{result}]`. `give_up` → check ratifies (evidence bar) → typed `Refused` in the loop's `Err` (`src/AI/Errors.ts:42-49`) — never the model's bare refusal.
- **Nag-on-neither**: `(AwaitingModel, ModelResponse with no tool calls, bounded halt)` → if `nagsRemaining > 0`, append the nag user message (Flue's `buildResultFollowUpPrompt`, `result.ts:29-34`) and emit `CallModel` with `toolChoice: { mode: "required", oneOf: ["resolve", "give_up"] }` (`LanguageModel.d.ts:212-217`) — **stronger than Flue's prose nag**: the provider is forced to call one of the two. Decrement `nagsRemaining`.
- **MAX_FOLLOWUPS analogue**: `nagsRemaining` initializes from the term's `AI.budget` (iterations ceiling, `src/AI/Budget.ts:15-30`) or a kernel default; exhaustion → `Refused{reason: "ended turns without resolve/give_up N times"}` — Flue's `session.ts:3565-3568` as a typed error. Because budget accounting is per-command (§9.3), the nag loop also burns tokens/wall-clock ceilings — it cannot spin outside the budget the way Flue's "no framework retry cap" (`session.ts:3532-3535`) can.

---

## 5. Flue's delta journaling + deterministic ids over the StreamPart stream

Flue journals every text/thinking delta and derives tool-outcome record ids from `(assistantMessageId, toolCallId)` so replay collides idempotently (`session.ts:871-872`: `` `${encodeCanonicalId(assistantMessageId)}_${encodeCanonicalId(toolCallId)}` ``; batch commit `record_tool_results_committed_${assistantMessageId}`, `:947-953`).

Our unit of identity is already deterministic: an assistant message is keyed by `(term, session, turn)` — so Flue's `(assistantMessageId, toolCallId)` becomes §2.3's `(term, session, turn, callId)` with nothing minted at emit time. Mapping the full `Response.StreamPart` union (`Response.d.ts:109`) to KernelEvents:

| StreamPart (Response.d.ts) | Durable? | KernelEvent | Deterministic id derivation |
|---|---|---|---|
| `response-metadata` (:1548-1565) | **durable** | `ModelRequested` (provider ack; carries provider response id + modelId in payload) | `(term, session, turn, "model")` |
| `text-start` (:310-315) / `reasoning-start` (:—) | live-only | `ModelDelta` (block-open) | n/a (no `seq`) |
| `text-delta` (:356-365) / `reasoning-delta` | live-only | `ModelDelta` | n/a — deltas can never advance the cursor (§2.3) |
| `text-end` / `reasoning-end` (:640-652) | **durable** | `ModelBlockCompleted` (accumulated text; reasoning may be redacted per policy) | `(term, session, turn, "block", blockOrdinal)` — **ordinal within the turn**, not the provider-minted `part.id` (cross-provider stability; Flue uses random block ids but we don't have to) |
| `tool-params-start/-delta/-end` (:664-758) | live-only | `ModelDelta` (arg fragments) | n/a — **never durable**: partial args are exactly the salvage-parse corruption class; only the final `tool-call` part is truth |
| `tool-call` (:863-881 — `id`, `name`, `params`, `providerExecuted`) | **durable** | `ToolRequested` (emitted before any gate — §2.3 normative ordering) | `(term, session, turn, part.id)` — `part.id` is the provider's callId, the pairing key; stable because it's in the transcript both sides sign |
| `tool-result` with `preliminary: true` (:963-975) | live-only | `ToolProgress` | n/a (only possible if we ever re-enable auto-resolution or use `HandlerContext.preliminary`, Toolkit.d.ts:72-82) |
| `tool-result` final / **our own `toolkit.handle` outcome** | **durable** | `ToolCompleted` / `ToolFailed` / `ToolBlocked` (distinct terminal events — §2.3) | `(term, session, turn, callId, "outcome")` — exactly one per callId (pairing invariant); replay collides, never duplicates. Persist `encodedResult` (Tool.d.ts:719-724 / Response.d.ts:955-957), which is the JSON-safe form built for re-prompting |
| `tool-approval-request` (:1164-1173) | **durable** | `Escalated` / `AskIssued` | `(term, session, turn, callId, "ask")` — do **not** persist the `approvalId` effect/ai mints via `IdGenerator` (LanguageModel.js:705-706) as identity; if the effect/ai approval flow is used at all, provide a deterministic `IdGenerator` Layer (IdGenerator.d.ts:80-82, layer :250 — the seam exists for exactly this) |
| `file` / `document-source` / `url-source` (:1240-…) | **durable** | `ToolCompleted` payload / attachment event | `(term, session, turn, "att", ordinal)`; large payloads go behind the fold's preview-and-drillback (§9.4 fold blind spots) |
| `finish` (:1739-1752 — `reason`, `usage`) | **durable** | `TurnEnded` (usage: `Response.Usage`, :1655-1708 — cache-read/write/uncached splits, all `number \| undefined`, i.e. §9.3's required shape verbatim) | `(term, session, turn)` — the turn's commit record; budget decrement commits in the same transaction |
| `error` (:1826-1828) | **durable** | `ModelFailed` (turn-scoped terminal) | `(term, session, turn, "error")` |

Two structural notes:

- **`Chat` is not the journal.** `Chat.Service` is a `Ref<Prompt.Prompt>` with export/import (`Chat.d.ts:89, 115, 143, 412, 452`) and a persistence hook that saves *whole history snapshots* per generation (`Persisted.save`, `:530-539`; `makePersisted`/`layerPersisted`, `:558-581`). That is a second transcript with snapshot granularity — precisely what §9.3 forbids ("never a second transcript") and what Flue refused (pi's state is "rebuilt by projection" from Flue's own records). Use `Chat.fromExport`/`exportJson` at most as a debugging codec; the transcript carrier inside `StepState` is `ReadonlyArray<Prompt.MessageEncoded>` (`Prompt.d.ts:1255`), serialized by the `Prompt` schema codec (`Prompt.d.ts:1303`) — schema-versioned, `structuredClone`-safe, and derivable from the Trace by a pure fold.
- The `finish`-before-tool-results ordering effect/ai guarantees in auto-resolution mode (deferred finish parts, `LanguageModel.js:733-756`) becomes *our* guarantee in disabled mode: the interpreter journals `TurnEnded` only after every `CallTool` of the batch has settled — the same write barrier pi enforces by awaiting event listeners in run settlement (`agent.ts:241-244`).

---

## 6. Pi/Flue compaction → the ContextPolicy seam

What both systems converged on (pi `core/compaction/compaction.ts`; Flue `compaction.ts` + `session.ts:2842-2996`): a **pure preparation** (cut point never at a tool result — `findValidCutPoints`, Flue `compaction.ts:394-404`; split-turn prefix handling, `:406-457`; `prepareCompaction` is documented "Pure function — no I/O", `:507-556`), a **replaceable summarize** (Flue: only the model is pluggable; pi: extensions can substitute the whole `CompactionResult`), and a **durable entry with provenance** (`{summary, firstKeptEntryId, tokensBefore, usage}`, Flue `session.ts:2984-2996`) that projection honors — never a destructive rewrite. Two triggers: threshold (`contextTokens > contextWindow − reserveTokens`, `compaction.ts:170-179`) and overflow (provider error → compact → retry the turn once).

The seam, over `Prompt`:

```ts
// Internal to the kernel Layer; absent from the Kernel interface (§2.6).
interface ContextPolicyService {
  /** Pure. Trace-derived prompt (repair-on-read already applied) → cut decision. */
  readonly prepare: (input: {
    readonly prompt: Prompt.Prompt                      // Prompt.d.ts:1278
    readonly usage: Response.Usage | undefined          // last TurnEnded's FinishPart.usage (Response.d.ts:1747)
    readonly contextWindow: number | undefined          // harness-provided model metadata — NOT in effect/ai (§7)
    readonly lastFold: FoldSnapshot | undefined
  }) => Option.Option<FoldPreparation>

  /** The replaceable half — runs as an ordinary agent arrow (a command, never inside `step`). */
  readonly summarize: (prep: FoldPreparation) =>
    Effect.Effect<FoldSnapshot, AiError.AiError, LanguageModel.LanguageModel>
}

interface FoldPreparation {                              // pi's CompactionPreparation, ours
  readonly toSummarize: Prompt.Prompt                    // slice below the cut
  readonly turnPrefix: Prompt.Prompt                     // split-turn prefix (may be empty)
  readonly firstKeptSeq: number                          // ≙ firstKeptEntryId — a Trace seq, the provenance link
  readonly previousSummary: string | undefined           // iterated-fold input (pi's update prompt)
  readonly tokensBefore: number
}

interface FoldSnapshot {                                 // durable Trace event `IterationFolded`
  readonly summary: string
  readonly firstKeptSeq: number
  readonly tokensBefore: number
  readonly promptHash: string                            // checkpoint fossil (§9.3)
  readonly usage: Response.Usage | undefined             // the fold's own cost — budgeted (Flue session.ts:2863-2868)
}
```

- **Cut-point rule over `Prompt`**: valid cuts are `user`/`assistant` message boundaries where no `tool-call` part in the assistant message lacks its `tool-result` in the following tool message — the pairing invariant expressed over `Prompt.Message` (`Prompt.d.ts:1248`); identical in content to pi's "never cut at toolResult".
- **Projection**: the rendered prompt is `Prompt.make([systemMsg, foldSummaryAsUser, ...keptMessages])` — assembled with `Prompt.concat`/`setSystem` (`Prompt.d.ts:1466-1517, 1550`). The fold snapshot is a Trace record; the prompt is always a projection (Flue's strongest design, flue study §3.1).
- **The summarizer is an agent arrow on a cheap model Layer.** The default is a plain `LanguageModel.generateText({ prompt: summarizationPrompt })` (`LanguageModel.d.ts:518-530`) whose `LanguageModel` requirement is satisfied by a *different* Layer than the ring's — `Model.make(provider, modelName)` is itself a `Layer<LanguageModel | ProviderName | ModelName>` (`Model.d.ts:30, 104`), so `summarize.pipe(Effect.provide(CheapModel))` is the whole mechanism. The upgrade path is the same shape one level up: a `Scribe` Agent term whose `ProcessService.dispatch` (`src/AI/Process.ts:43`) the kernel invokes as the Fold ref — the summarizer *is an ordinary agent*, with its own Trace, budget, and model Layer. Pi's `custom-compaction.ts` example (cheaper model) and Flue's `compaction.model` config are both subsumed by Layer provision, with zero config vocabulary (the §0.4 claim, demonstrated).
- **Triggers in the interpreter** (per-command, not per-boundary — pi #4325): threshold checked after every `TurnEnded` feedback using `FinishPart.usage.inputTokens.total`; **overflow** caught on the `CallModel` effect — but note effect/ai has **no typed context-overflow reason** (verified: `AiError` reasons are Network/RateLimit/QuotaExhausted/Authentication/ContentPolicy/InvalidRequest/InternalProvider/InvalidOutput/…, `AiError.d.ts:19, 262, 321, 377, 435, 493, 555, 613, 795`). Overflow arrives as `InvalidRequestError` with provider-specific text — a distilled-doctrine-style gap flagged in §7. Compact-then-retry-once on overflow matches Flue (`session.ts:2760-2770`); the retried `CallModel` is a fresh command, so the budget sees it.

---

## 7. The two-way gap list

### What pi/Flue have that effect/ai + our current design still lacks (ours to build)

1. **Salvage-parse guard** — fail the whole tool batch when `FinishPart.reason === "length"` (pi `agent-loop.ts:207-216`). Not just missing from effect/ai: auto-resolution actively defeats it (§0). Step-machine rule, specified in §2.
2. **The turn→turn loop itself** — steering/follow-up drain points, nag, would-stop; effect/ai is single-round by design.
3. **Durable admission inbox** — Flue's plane-1 submission store (idempotent by dispatch id, per-session FIFO, attempt markers, advisory leases on DOs). Nothing in effect/ai; harness seam.
4. **Repair-on-read** — a pure normalization pass over Trace-derived messages that fills unpaired `tool-call`s with synthetic interrupted/error `tool-result` parts before rendering. `Prompt` accepts arbitrary message arrays; providers reject unpaired calls; no repair exists in effect/ai. (Flue enforces it at the persistence layer — `repairTrailingPartialToolBatch`, `session.ts:3263-3294`; ours composes with any fold/trim.)
5. **Typed context-overflow detection** — pi-ai ships `isContextOverflow` (Flue `compaction.ts:20, 741`); effect/ai has no such reason (§6). Until upstream grows one, the kernel needs a per-provider overflow classifier over `InvalidRequestError` — quarantined in the provider-adjacent Layer, never in step logic.
6. **Model metadata catalog** — `contextWindow`, `maxTokens`, per-token cost (pi-ai `models.generated.ts`; Flue's `deriveCompactionDefaults`, `compaction.ts:51-72`). effect/ai's `Model` carries only provider/model *names* (`Model.d.ts:54, 69`); `Usage` reports consumption, not capacity. Threshold compaction and `usd` budgets need a harness-provided catalog service.
7. **Recovery classification** — Flue's `classifyConversationSubmission` states (`completed | resume | tool_results_partial | tool_use_unresolved | advanced_past_input | terminal_error`, `session.ts:3223-3297`) as the `Recovered` feedback payload; effect/ai has no persistence-of-progress concept at all (Chat snapshots are not it — §5).
8. **Event-stream settlement barrier** — pi's "the run is not idle until `agent_end` listeners settle" (`agent.ts:241-244, 527-573`) → our Trace-write barrier before a run resolves. Ours to enforce in the interpreter.
9. **Token estimation for un-usaged content** — chars/4 fallback for trailing messages (Flue `compaction.ts:107-168`). Trivial but ours.
10. **Halt schema constraint** — `Halt.schema: S.Top` (`src/AI/Halt.ts:37`) must narrow to `Schema.Constraint` for `Tool.dynamic` compatibility (`Tool.d.ts:950-960`); adjust `AI.until`'s signature in Phase 1.

### What effect/ai gives us that pi/Flue hand-rolled (free wins)

1. **Typed tool schemas end-to-end** — `Tool.make`/`Tool.dynamic` (Tool.d.ts:810-860, 905-971), validation + result encoding inside `Toolkit.WithHandler.handle` (Toolkit.d.ts:141-155), `failureMode: "return"` for model-visible errors (Tool.d.ts:81-96). Pi hand-rolled TypeBox validation + salvage parsing; Flue double-validated with valibot inside `execute` (`result.ts:207-235`).
2. **Provider-normalized streaming** — one `StreamPart` union across providers (Response.d.ts:109), schema-decoded (`Response.StreamPart(toolkit)` codec, :123). Pi-ai normalized ~30 providers by hand.
3. **The approval half of HITL** — `needsApproval` (static or per-call function with conversation context, Tool.d.ts:104-133), `tool-approval-request`/`-response` parts, approved-execution + **typed model-visible denials** on the next round (LanguageModel.js:613-651, 987-1030). Pi has no core HITL; Flue has none at all. Our Ask protocol keeps park-durably/verdict-amendment/signing, but the transcript grammar is shipped.
4. **Structured output** — `generateObject` with schema + provider-specific codec transformers (LanguageModel.d.ts:69, 564; `AnthropicStructuredOutput`/`OpenAiStructuredOutput` modules). Flue's `finish`-tool envelope trick (`needsEnvelope`, result.ts:342-346) remains right for *halts* (a halt must coexist with a tool loop), but one-shot extraction arrows (Check verdicts!) get `generateObject` directly.
5. **Prompt algebra** — `make`/`fromMessages`/`fromResponseParts`/`concat`/`setSystem` (Prompt.d.ts:1377-1550) with a serialization codec (:1303). Pi's `convertToLlm` default + message normalization, as a library.
6. **Usage with cache splits** — `Response.Usage` (:1655-1708) is §9.3's "AI SDK v4 shape" verbatim (uncached/total/cacheRead/cacheWrite, every count possibly absent). Pi-ai normalized this per provider by hand.
7. **`IdGenerator` as a seam** (IdGenerator.d.ts:47-82, 250) — deterministic ids injectable where effect/ai mints them; pi/Flue had to own every id call site.
8. **Typed provider error taxonomy** — `AiError` reasons with schemas (AiError.d.ts) vs pi-ai's string matching. (Minus the overflow gap, above.)
9. **`toolChoice` forcing** (LanguageModel.d.ts:212-217) — the nag turn can *require* `resolve|give_up` (§4); pi/Flue could only ask nicely in prose.
10. **Incremental prompts / response-id tracking** (`ProviderOptions.previousResponseId`/`incrementalPrompt`, LanguageModel.d.ts:437-444; `ResponseIdTracker`) — provider-side conversation caching neither pi nor Flue exploits.

---

## 8. Implementation order — smallest path to a pi-grade turn loop inside `kernel.interpret`

Target: `kernel.interpret(SomeAgent)` returns a `ProcessService` whose `dispatch` runs a real multi-turn tool loop — the substrate `CloudflareAgent.test.ts` drives. Each step is testable before the next.

1. **Constrain `AI.until`'s schema to `Schema.Constraint`** (Phase-1 term fix, §7.10) and add the `Steered`/`InboxEmpty` feedbacks + `Boundary`/`WouldStop` phases to the §2.4 vocabulary. Pure type work.
2. **Stage A link (pure)**: walk `term.refs` → resolve tool impls from ambient context (`Effect.serviceOption(toolRef)`) → `Tool.dynamic` per tool + `Toolkit.make`/`merge` + `toLayer` handlers; render the prose → system prompt + `promptHash`; synthesize the `resolve`/`give_up` pair from the halt ref (§4). Unit-testable with a fixture term and stub tool Layers — no model.
3. **Pure step machine**: `StepState` (encoded-transcript carrier), `step(state, feedback)` transitions from §2 + §4 — happy path, tool batch, length-truncation batch-fail, nag, first-call-wins, boundary/would-stop drains. Property tests: pairing invariant under arbitrary feedback orders; `structuredClone` round-trip; determinism under replay. No effect/ai imports beyond types.
4. **Command interpreter (the only impure loop)**: `CallModel` → `LanguageModel.streamText({ prompt, toolkit, toolChoice, disableToolCallResolution: true })`, collect parts into `ModelResponse`; `CallTool` → ToolInterceptor (pass-through default) → `toolkit.handle` → last non-preliminary result → `ToolResult`; batch concurrency with source-order results. Feed `step` until `Halt`. Test against a scripted fake `LanguageModel` Layer (a `LanguageModel.make` provider hook replaying canned `StreamPartEncoded` arrays — LanguageModel.d.ts:478-492 makes this a ~30-line fixture).
5. **Trace emission**: deterministic-id derivation table from §5; durable/live split; `TurnEnded` write barrier after batch settlement; wire `Kernel.events`/`Kernel.trace`. Conformance: replay the Trace, ids collide idempotently.
6. **Admission inbox + steer**: in-memory ordered inbox behind `ProcessService.send`/`steer`; drain at the two points; `dispatch = send + await` identity test; steering mid-run resets the step allowance.
7. **Budget accounting**: decrement from `FinishPart.usage` per `CallModel` and per `CallTool`; ceilings fire between commands; `BudgetExceeded{resumeHint}` parks with fold + work item retained.
8. **ContextPolicy default** (naive truncation via `prepare` over `Prompt`, threshold from a harness `ModelCatalog` stub) + overflow classify-compact-retry-once. The summarize arrow on a second `Model` Layer proves per-role model provision.
9. **`AI.Kernel.memory`** assembles 2–8 behind the `Kernel` tag; the conformance suite (pairing under trims, replay determinism, steer delivery points, halt/refuse/budget exits) runs against it — and then verbatim against the Cloudflare harness, whose `CloudflareAgent.test.ts` swaps the inbox for the Ring DO ledger (Flue plane-1), the Trace store for DO SQLite, and interruption settlement for the `Recovered` classification.

Steps 2–4 alone are the pi-grade loop (pi's `runLoop` + `Agent` wrapper, ~1,400 lines, replaced by one pure function + one interpreter over four effect/ai calls: `streamText`, `toolkit.handle`, `Prompt` assembly, and a provider `Model` Layer). Steps 5–8 are what pi never had and Flue proves we need.

---

## Honesty notes

- All effect/ai citations verified against `node_modules/effect/dist/unstable/ai/*.d.ts` at the vendored version (effect v4, unstable namespace). Behavioral claims about `streamText`'s single-round semantics, handler forking before finish, approval pre-resolution, and denial synthesis were verified in `LanguageModel.js` (lines cited), not inferred from types.
- `Schema.Constraint` vs `S.Top` (`Halt.schema`) compatibility was **not** proven by a compile — flagged as implementation-order step 1 rather than assumed.
- I did not run any code; the scripted-provider fixture in step 4 is a design claim based on `LanguageModel.make`'s signature (`LanguageModel.d.ts:478-492`), not a working artifact.
- The claim that effect/ai lacks a typed context-overflow reason is based on an exhaustive read of the `AiError.d.ts` reason classes; if a provider package (`@effect/ai-anthropic` etc.) maps overflow to a distinct reason, the classifier in §7.5 shrinks accordingly — I did not audit the provider packages.
- Pi/Flue citations are into the vendored clones at the commits pinned in the prior reports (`designs/ai/reports/pi.md`, `flue.md`); line numbers re-verified for every mechanic used here (steering poll points, truncation rule, result tools, outcome-id derivation, recovery classification, compaction preparation).
