# The Elm Architecture, Redux, and Effects-as-Data — applied to alchemy's charter/stance model

Research note for the Alchemy AI kernel design. Topic: the functional state-management family — Model-View-Update (TEA), Redux/reducers, effects-as-data (Cmd/Sub, redux-saga, re-frame), and The Composable Architecture (TCA) — and what they predict about, and offer to, LLM agentic loops that work toward goals and run in perpetuity.

## 1. The paradigm (precise semantics)

The Elm Architecture is four functions over two closed types:

```
init          : flags -> (Model, Cmd Msg)
update        : Msg -> Model -> (Model, Cmd Msg)
view          : Model -> Html Msg
subscriptions : Model -> Sub Msg
```

The semantics, stated precisely:

- **State changes only through messages.** `Model` is immutable; the *only* function that produces a new Model is `update`, and it fires only when a `Msg` arrives. `Msg` is a closed union (an ADT), so `update` is checked for exhaustiveness. There is no other write path — views cannot mutate, callbacks cannot mutate, effects cannot mutate.
- **Effects are data, executed by the runtime.** `update` never performs I/O; it *returns* a `Cmd Msg` — a pure description of an effect ("POST this, then wrap the response in `GotResponse`"). The runtime executes it and feeds the result back in as another `Msg`. The program is a fold: `model_n = foldl update model_0 [msg_1 … msg_n]`, with effects as annotations on the fold's output that generate future inputs.
- **The view is a pure function of the model** — `v = f(s)`. Crucially, `Html Msg` is parameterized by the message type: the view *declares which messages user interaction may produce*. A button the view does not render this frame cannot emit its message this frame.
- **Subscriptions are a function of the model.** After every update, the runtime recomputes `subscriptions model` and diffs the declared interest set against reality — opening/closing websockets, starting/stopping timers. This is Elm 0.17's replacement for FRP signals ("A Farewell to FRP"): components "sit around and wait for messages while library code handles resource management." Interest is *state-dependent*: a model in a parked phase can subscribe to nothing.
- **Replay and time-travel fall out of purity.** Because the model is a fold over a serializable message log, you can replay, bisect, and time-travel-debug for free. Redux DevTools industrialized this.

**Redux** is TEA's `update` transplanted to JS with three principles (redux.js.org): single source of truth (one store, one serializable tree), state is read-only ("neither the views nor the network callbacks will ever write directly to the state" — they dispatch actions), changes via pure reducers. Redux core has *no* effect story; middleware fills the hole. **redux-saga** is the effects-as-data variant: sagas are generators that `yield` declarative effect descriptions (`call(fetch, url)`, `put(action)`) which the middleware interprets — so a saga is unit-tested by stepping the generator and asserting on the yielded *descriptions*, never executing anything. **`useReducer`** is the reducer alone, with effects exiled to `useEffect` — the gap that motivates TCA.

**re-frame** (Day8, ClojureScript) closes the loop event-first: six dominoes — event dispatch → event handling → effect handling → query → view → DOM. Event handlers are pure functions that return effect *data* (`{:db new-db, :http-xhrio {...}}`); registered effect handlers execute it. Interceptors (data, not higher-order middleware) wrap handlers. Domino 4 is the distinctive part: **subscriptions as a de-duplicated signal graph of materialized views** over the app-db — derived values flowing, so views subscribe to *queries*, not to raw state.

**TCA** (Point-Free's Composable Architecture, Swift) is the industrial-strength descendant and the most relevant comparison. `Reducer` is a protocol: `reduce(into state, action) -> Effect<Action>` (in-place mutation of a value type — ergonomics — but semantically pure). Its three additions to TEA:

1. **Reducer composition by scoping.** A parent embeds a child feature with `Scope(state: \.child, action: \.child) { ChildFeature() }` — a lens/prism pair. Child features are fully isolated, independently testable, and glued back mechanically.
2. **Dependency injection as a first-class system.** Effects reach the world only through `@Dependency(\.numberFact)`-style injected clients; tests swap in deterministic ones. Purity of the reducer is preserved *and* effects stay testable.
3. **The exhaustive `TestStore`.** `store.send(.buttonTapped) { $0.count = 1 }` — every state mutation must be asserted or the test fails; every action an effect feeds back (`store.receive(\.response)`) must be received and asserted. Untested state drift is a compile-of-the-test failure. This is the strongest testing story any UI architecture has shipped.

## 2. Primary sources

Actually read for this note:

- **guide.elm-lang.org/architecture** — the Basic Pattern chapter (Model/View/Update). https://guide.elm-lang.org/architecture/
- **Evan Czaplicki, "A Farewell to FRP"** (Elm 0.17 announcement) — full text: subscriptions, effect managers, the removal of signals, the websocket example, the BEAM-inspired scheduler, and the retrospective "Elm was never about FRP." https://elm-lang.org/news/farewell-to-frp
- **Redux, "Three Principles"** — full text. https://redux.js.org/understanding/thinking-in-redux/three-principles
- **TCA README** (pointfreeco/swift-composable-architecture, main) — full text: `@Reducer`, `Effect<Action>`, `.run { send in … }`, `TestStore` exhaustivity, `@Dependency` registration. https://github.com/pointfreeco/swift-composable-architecture
- **re-frame, "A Data Loop"** — full text: six dominoes, effects-as-data event handlers, the signal-graph subscription layer. https://day8.github.io/re-frame/a-loop/

From prior knowledge (not re-fetched): Czaplicki's thesis *Elm: Concurrent FRP for Functional GUIs* (2012) — the signal-graph origin that "Farewell to FRP" retired; redux-saga's declarative-effects testing model (redux-saga.js.org — fetch timed out during research; claims here are standard and load-bearing only for §5's rejection of saga-style effect descriptions); Redux DevTools time-travel; TCA's `Scope`/`ifLet` composition operators and non-exhaustive test stores.

## 3. Mapping to LLM agentic loops

The mapping is unusually clean, because an agentic run *already has* the two halves TEA insists on separating — it just doesn't enforce the separation.

| TEA | Alchemy run |
|---|---|
| `Model` | run state: the `AI.local` cells (phase, counters) + activated skills + frozen head |
| `Msg` | transcript events: work item (`send`/`dispatch`), `steer`, model response, tool call, tool result, situation, `settle` |
| `update` | **implicit** — scattered across inline tool closures (`phase.set(…)`) and kernel bookkeeping (`run.active.add`) |
| `view` | the TURN effect: `stance = view(runState)` — already a (near-)pure function of the locals |
| `Html Msg`'s message vocabulary | the tick's toolkit: mention-is-presence |
| `Cmd` | tool executions (currently direct, inside the sampling step) |
| `subscriptions model` | the implementation Layer's `consumeRepositoryEvents` wiring (currently static, not a function of run state) |
| Redux single store | the Actor's keyed run map (deliberately *not* single — per-run isolation) |

Four observations carry the analysis:

**(a) The stance is already an Elm view — the strongest part of the current design.** The turn reads locals and returns a Fragment; the kernel renders it and derives the toolkit from mentions. This is exactly `view : Model -> Html Msg`, including the subtle part: `Html Msg` declares which messages the user *may* produce this frame, and the stance declares which tool calls the model *may* produce this tick. "A tool a branch does not render this tick is not in the toolkit this tick" is precisely "a button not rendered this frame cannot fire." Alchemy independently reinvented TEA's view contract, which is evidence the family is the right lens.

**(b) The transcript is already an event log — but the run state is not a fold over it.** TEA's deepest property is that `Model` is *derivable*: replay the messages, recover the state. Alchemy's transcript (user messages, model responses, tool calls/results, situations) is exactly a `Msg` log — but `AI.local` cells are mutated imperatively by closures during tool execution, and those mutations live only in an in-memory `Map<symbol, unknown>` (`Run.current.locals`). Today, state changes *happen* to coincide with transcript events (a `phase.set` only ever fires inside a tool handler, and every tool call+result is a transcript entry), but nothing enforces that, and the fold function is not written anywhere — it's smeared across closures. Consequences:

- **Durability:** crash = lost locals. For the planned durable kernel on Cloudflare Durable Objects this is the load-bearing hazard: the transcript must be persisted anyway (it's the conversation), so any state *not* derivable from it is extra machinery — a second thing to persist, with its own consistency protocol against the log.
- **Replayability:** you cannot reconstruct "what stance did the model see at tick 17" from the transcript alone, because you cannot reconstruct the locals at tick 17. Time-travel debugging of agent transcripts — the thing that made Redux famous — is off the table.
- **Serialization:** worse, locals are keyed by `Symbol("alchemy/AI/Local")` — process-local identity from the construction site. Even a perfect snapshot of the `Map` cannot be rehydrated in a new isolate, because the new isolate's `AI.local` calls mint *new* symbols. The current key scheme makes run state unserializable *by construction*. This is a bug against the durable-kernel roadmap independent of any Elm argument.

**(c) The tool-call protocol is already effects-as-data — at the model boundary.** The LLM does not perform effects; it emits a *description* (`{name: "await_author", args: {}}`), the runtime executes it, and the result re-enters the transcript as data. The model is `update`, tool-call parts are `Cmd`, tool results are the wrapped `Msg`s. LLM APIs forced this shape on everyone, and it is exactly Elm's shape. What is *not* effects-as-data is the handler side: alchemy handlers run arbitrary Effects immediately, inside `generateText`, and a crash mid-step loses both the effect's outcome and the state mutations it made. Elm/saga would record the intent before executing (the tool-call message *is* that record — if it's persisted before the handler runs).

**(d) The decision-maker is the LLM, not the reducer — this is where the analogy must stop.** In TEA, `update` is the entire brain; purity is affordable because *all* behavior lives in a function you wrote. In an agentic loop, the deterministic shell is deliberately thin — `issues.ts`'s whole "state machine" is one two-valued phase — and the behavior lives in prose interpreted by a stochastic model. The payoff of reducer discipline scales with the fraction of behavior that is deterministic; forcing the charter author to enumerate a closed `Msg` union and write `(state, event) => [state', stance]` buys purity for the 5% of the system that's already simple, while taxing the idiom (closure-based inline tools, prose-as-program) that carries the other 95%. Redux would also predict our nondeterminism problem wrongly: replaying a transcript through a *reducer* is deterministic, but replaying it through a *model* is not — replay in alchemy means replaying the fold (cheap, exact) while treating recorded model responses as inputs, not re-sampling them. That's event sourcing's replay, not Elm's; the distinction matters for the durable kernel (recorded responses are facts; the reducer must be pure so the facts fold identically).

The remaining mappings:

- **Subscriptions.** Elm recomputes `subscriptions model` after every update; interest is state-dependent, and the runtime babysits resources. Alchemy's Layer wiring (`IssueOpened ⇒ send`, `IssueCommented ⇒ steer`, `IssueClosed ⇒ settle`) is static routing chosen once per Layer, independent of run phase. Functionally fine — a parked run just gets woken and its stance says "judge the reply" — but *economically* wrong: every steer wakes a sampling, and a sampling costs real money. A parked run that could declare "wake me only for author comments" turns an LLM call into a predicate call. Elm's insight (interest as a pure function of state, diffed by the runtime) is directly stealable as a **wake predicate**, without moving routing into the charter.
- **Msg alphabets.** Elm's closed unions give exhaustiveness; alchemy's `Actor<In>` derives `In` from the prose's spliced Events plus `string`, and `steer`/`settle` accept `unknown` at the edges. The alphabet exists but is advisory. Tightening it matters most where the fold matters: if run state becomes a fold, the fold's input type should be closed, or the reducer can't be total.
- **TCA's three lessons** land as: (composition) child charters compose today by fragment nesting — turn values spliced into parent prose — which composes the *view*; TCA warns that composing *state* needs explicit scoping (its `Scope` lens), and alchemy's equivalent is that a child's locals need stable, namespaced keys or persistence/replay of a composed charter is ambiguous. (dependencies) TCA's `@Dependency` is Effect's Layer system, which alchemy already has in stronger form — capability inference through `R` is *better* than TCA's dictionary. The missing piece is not injection but the **scripted model**: a `LanguageModel` test Layer that plays back canned responses. (testing) the `TestStore`'s exhaustive assertion discipline is the direct model for a kernel test harness — see §5.

## 4. Comparison with alchemy's charter/stance/kernel model

What Elm/Redux predict breaks, checked against the actual code:

1. **Untracked mutation** — *confirmed, and it's the durability hazard.* `Local.set` writes an in-memory Map keyed by process-local Symbols (`Run.ts`); nothing journals the write; `run.active` (skill activations) has the same problem. Redux's second principle exists precisely to prevent this class: writes that no log records. Verdict: the *semantics* must change (writes become recorded events); the *surface* (`phase.set`) can stay.
2. **Unreplayable state** — *confirmed as a consequence of 1.* The transcript can be persisted and replayed as a conversation, but the interleaved stance/toolkit evolution cannot be reconstructed, so neither debugging-by-replay nor DO-rehydration works. Once state is a fold over the (already-persisted) transcript, both fall out — the Redux DevTools experience, but for agent runs: scrub the transcript, watch the stance and toolkit change tick by tick.
3. **Effect timing** — *partially confirmed.* Handlers execute inside the sampling step; a crash after a handler's side effect but before the response is persisted re-executes the handler on replay. Elm's answer (effects are data; the runtime owns execution) maps to a journaled tool-execution protocol in the durable kernel: persist the tool-call event, execute, persist the result event; on recovery, a call without a result is re-executed (handlers should be idempotent or keyed). This is invisible to charter authors.
4. **View purity** — *already satisfied, mostly.* The turn is re-evaluated every tick and only reads through handles; `renderStance` evaluates Effect-valued splices at render time, which is the one place impurity could creep in (a splice that performs I/O makes the view non-replayable). Worth an explicit doctrine: turn effects and splices must be pure reads of run state + context.

Where the current model is *right* and the family's advice should be declined:

- **Per-run isolation over a single store.** Redux/re-frame's single app-db suits one UI; an Actor hosting hundreds of `owner/repo#n` runs is an actor system, and per-run state with message-passing is the correct topology (Elm itself went BEAM-ward in 0.17's scheduler). Cross-run coordination belongs in Process Shapes and the Ledger, not a global tree.
- **Prose as the program.** TEA has no analog of "the view is the behavior" — its view is inert output. In alchemy the stance *is* the policy, interpreted by the model. That inversion is the framework's bet and nothing in this family argues against it; TEA only argues about the *deterministic scaffolding* around it.
- **Closure-based inline tools.** The Elm-pure alternative — tools as pure Msg constructors, all consequences in a central reducer — would split one cohesive idea (`awaitAuthor` = description + effect + state change, seven lines in `issues.ts`) across an action union, a reducer branch, and a tool table. TCA itself moved *toward* colocation (`@Reducer` bodies with inline `.run` effects) because the split hurts. Keep the closures; journal what they do.

## 5. Steal / adapt / reject

### STEAL 1: run state as a fold — journaled locals with stable keys

The single highest-value change, and it needs no new charter surface. Give locals stable names and route writes through the kernel as recorded events:

```ts
// Charter surface: one added argument (the stable key)
const phase = yield* AI.local("phase", "triaging" as "triaging" | "awaiting-author");
```

```ts
// Kernel semantics: Local.set appends a state event; the Map is a cache of the fold
interface StateEvent {
  readonly _tag: "LocalSet";
  readonly key: string;          // "phase" — stable across isolates & versions
  readonly value: unknown;       // must be serializable (schema-checkable later)
  readonly seq: number;          // position relative to transcript entries
}

// The run's journal interleaves with the transcript; recovery is a fold:
const recover = (journal: ReadonlyArray<StateEvent>) =>
  journal.reduce((locals, e) => locals.set(e.key, e.value), new Map<string, unknown>());
```

`run.active` (skill activation) joins the same journal (`{_tag: "SkillActivated", name}`) — it is state that today only exists as a Set mutation inside the `skill` intrinsic. In `KernelMemory` the journal can be a no-op array; in the DO kernel it is the persistence unit, snapshotted at quiescence (event-sourcing's snapshot+log, not pure replay — reducer versioning across deploys is the known cost, mitigated by snapshots). **This preserves the imperative ergonomics exactly** — `phase.set` still reads as mutation — while making the semantics Redux-legal: no write without a recorded action. The Symbol-keyed Map must go regardless; it is unserializable by construction.

### STEAL 2: the TestStore — scripted model + exhaustive kernel harness

TCA's `TestStore` translated: the model is the dependency to inject (a Layer, which alchemy already has), and the harness asserts every state transition and stance change per tick:

```ts
const test = yield* AI.TestKernel(Issues, charter, {
  model: AI.scriptedModel([
    AI.reply({ toolCalls: [{ name: "await_author", args: {} }] }),
    AI.reply({ text: "parked." }),
  ]),
});
yield* test.send(issueOpened, { key: "o/r#7" });
yield* test.expectTick({ toolCalled: "await_author", state: { phase: "awaiting-author" } });
yield* test.expectStance((s) => s.includes("parked on its author")); // view assertion
yield* test.expectQuiescent();  // exhaustive: unconsumed script entries or unasserted state = failure
```

This makes charter logic (phase transitions, stance branches, tool grants per tick) deterministic to test with zero live-model cost. It falls straight out of STEAL 1: `expectTick`'s state assertion reads the journal, and exhaustivity means the test fails if the journal contains events the test didn't assert — TCA's discipline verbatim.

### STEAL 3: closed steer alphabets where the charter declares events

`Actor<In>` already derives `In` from spliced Events; enforce it end-to-end so a Process's runs have a closed input union (`IssueOpened | IssueCommented | string`), making the journal's event type total and the Layer's `Match.exhaustive` checkable against the charter's declarations rather than merely against the subscription list.

### ADAPT 1: subscriptions → a wake predicate (cost discipline, not routing)

Don't move event routing into the charter (the Layer owns the world). But let the run declare *interest* as a pure function of its state, diffed by the kernel before paying for a sampling:

```ts
const charter = Effect.gen(function* () {
  const phase = yield* AI.local("phase", "triaging" as Phase);
  return AI.turn({
    // Elm's `subscriptions model`: evaluated at each boundary, decides if a steer wakes a sampling
    wake: (input) =>
      Effect.map(phase.get, (p) => p !== "awaiting-author" || isAuthorComment(input)),
    stance: Effect.gen(function* () { /* today's turn */ }),
  });
});
```

A parked issue ignores drive-by comments for the price of a predicate instead of a sampling. Non-matching inputs still enter the transcript (delivered in a batch at the next wake) so no information is lost — the predicate gates *sampling*, not *delivery*.

### ADAPT 2: journaled tool execution in the durable kernel

Effects-as-data at the kernel boundary only: persist the tool-call event before running the handler, persist the result after, re-execute call-without-result on recovery. Charter authors keep writing direct Effect handlers; durability is the kernel's concern. (This is Elm's runtime-owns-execution, and also just standard workflow-engine journaling — the two converge here.)

### REJECT 1: `(state, event) => [state', stance]` as the charter API

The LLM is `update`; the deterministic reducer around it is thin by design. A mandatory closed Msg union + central reducer taxes every charter to purify its smallest part, and the fold-over-transcript invariant (STEAL 1) captures the entire durability/replay benefit without the surface change. Revisit only if charters grow deterministic state machines with >5–6 states — at which point an *optional* `AI.machine(reducer)` combinator that journals through the same mechanism is the escape hatch, not a new foundation.

### REJECT 2: single global store / re-frame app-db across runs

Per-run isolation with world-keyed actors is correct for a fleet; cross-run views belong in Process Shapes (already the design). re-frame's signal-graph subscriptions are beautiful for derived UI views but have no consumer here — the "view" is regenerated per tick per run anyway.

### REJECT 3: saga-style effect descriptions in user code

Effect *is* the managed-effect system — typed, injectable via Layers, testable by substitution. Wrapping handlers' effects in a second description layer (like saga's `call`/`put`) would duplicate Effect's runtime to recover testability that Layers already provide.

## 6. Open questions

1. **Journal ordering vs the transcript.** Are `LocalSet` events interleaved *within* a model step (multiple tool calls per response, each mutating state) ordered by tool-call id, or is per-step ordering enough for replay? Parallel tool execution would force per-call ordering.
2. **Reducer/version drift.** Snapshots mitigate but don't eliminate: a run parked for three weeks wakes under a redeployed charter whose locals have different types. Upcasting? Schema on `AI.local`? Or accept snapshot-forward-only semantics?
3. **What is the stance's replay contract?** If a splice evaluates an Effect that reads a Process Shape (live world data), the view is not a pure function of run state — replayed ticks render differently. Do we forbid it, or journal rendered stances too (making replay exact but the journal heavy)?
4. **Should skill activation and the frozen head live in the same journal** as locals, or is the head derivable (it's tick 1's rendered stance — derivable iff question 3 resolves to "pure")?
5. **Wake predicates vs steering semantics.** If a parked run defers inputs, does `dispatch` (which awaits quiescence) against a parked run with deferred inputs resolve immediately with the old outcome, or force a wake? The Elm answer (subscriptions don't affect command processing) suggests: `dispatch` always wakes; only `steer` is gated.
6. **Hierarchical charters.** When a child charter (component with its own locals) is spliced into a parent, do its journal keys need namespacing (`child/phase`) TCA-`Scope`-style, and who assigns the namespace — the splice site or the child's declaration?
