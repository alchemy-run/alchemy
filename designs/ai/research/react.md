# React: reconciliation, hooks, fiber, and "React for agents"

Research memo for the Alchemy AI kernel design. Grounded in `packages/alchemy/src/AI/{Kernel,KernelMemory,Prose,Run,Actor,Agent,Process,Skill}.ts` and `services/alchemy-org/src/{issues,engineer}.ts` as of this writing.

## 1. The paradigm (precise semantics)

React's contract, stated carefully, because every clause maps (or fails to map) to our kernel:

**UI = f(state), render is discardable.** A component is a pure function from props+state to an immutable *element tree* — a description, not the thing itself. Rendering (calling the functions) may be re-run, thrown away, or interrupted at any time with no observable effect. Purity is what buys the scheduler its freedom.

**Commit applies minimal mutations to a retained tree.** The rendered description is diffed against the previous one (reconciliation) and only the delta is written to the retained, mutable target (DOM / native views). The commit phase is synchronous, uninterruptible, and idempotent in the sense that writing the same props twice is harmless. Crucially, React is an *immediate-mode programming model over a retained-mode target*: you re-describe everything every frame; the framework preserves retained-mode efficiency by diffing.

**Identity = position + type + key.** State does not live "in" a component; it lives in React's retained tree, associated with a position. Same component type at the same position across renders ⇒ state preserved. Different type, different position, or different `key` ⇒ subtree torn down, state destroyed, effects cleaned up. Keys exist to give list items identity that survives reordering. This preserve-vs-reset rule is the load-bearing semantics of the whole model: it is how React decides what is "the same thing over time."

**Hooks = state slots keyed by call order within an instance.** `useState` slots are indexed by call sequence, which is why hooks can't be conditional. Abramov's defense of call order is that the alternatives all break *composition of custom hooks*: explicit string keys collide when two custom hooks (or two instances of one) use the same key (the diamond problem); symbol/factory workarounds break copy-paste and currying. Call order is positional identity again, one level down.

**Effects reconcile the external world with the render.** `useEffect` is synchronization, not lifecycle: after commit, make the outside world (subscriptions, imperative APIs) match the rendered output; clean up and re-run when dependencies change.

**Fiber = interruptible render, prioritized.** A fiber is a virtual stack frame — a unit of work with `type`, `key`, `pendingProps/memoizedProps`, a priority, and an `alternate` (double-buffered work-in-progress tree). Rendering is incremental and abortable; the scheduler is *pull-based* — React decides when work runs, coalesces and batches updates, and prioritizes interactive lanes over background lanes (with expiration to prevent starvation). Only the commit is atomic.

**Suspense** models async data as render-blocking: a component throws a promise, React shows a fallback, re-renders when it resolves. Transitions mark updates as interruptible/low-priority so urgent renders (typing) preempt slow ones (search results).

**React Server Components** are a second render loop with a serialization boundary: server components render to a serializable intermediate (the RSC payload) which may contain data, markup, and *references* to client components (module references, not closures). No state or effects on the server side; the payload is re-fetchable pure data; behavior crosses the boundary only by named reference.

## 2. Primary sources

Read in full or substantial part for this memo:

- **"Render and Commit"** — https://react.dev/learn/render-and-commit (read in full). Trigger → render → commit; render purity; minimal DOM mutation; "React does not touch the DOM if the rendering result is the same as last time."
- **"Preserving and Resetting State"** — https://react.dev/learn/preserving-and-resetting-state (read in full). State tied to position in the render tree; same component/same position preserves; keys force reset; "it's the position in the UI tree — not in the JSX markup — that matters."
- **Andrew Clark, "React Fiber Architecture"** — https://github.com/acdlite/react-fiber-architecture (read in full). Fibers as virtual stack frames; pull-based scheduling; reconciliation vs rendering split; priority; the `alternate` double buffer. (Lin Clark's "A Cartoon Intro to Fiber", https://www.youtube.com/watch?v=ZCuYPiUIONs, covers the same ground; not re-watched, known material.)
- **Dan Abramov, "Why Do Hooks Rely on Call Order?"** — https://overreacted.io/why-do-hooks-rely-on-call-order/ (read the flaw catalog). Key-collision/diamond problems of every non-positional alternative. His "A Complete Guide to useEffect" (https://overreacted.io/a-complete-guide-to-useeffect/) — known material; effects as synchronization, each render sees its own props/state.
- **AIDK** — https://rlindgren.github.io/aidk/ (read in full). Tick-based engine, "Context Object Model," lifecycle hooks per tick, tools-as-components.
- **agentick** — https://github.com/agenticklabs/agentick (README read in full; same author as AIDK, appears to be its successor). A real `react-reconciler` whose render target is the model context; `<Timeline>` as a render-function component; knobs/gates; React DevTools works against the agent tree.
- **agentjsx** — https://github.com/smithery-ai/agentjsx (repo is a stub, 5 stars, no README content retrievable; noted for completeness, not load-bearing).
- **agentry** — https://github.com/colinds/agentry (surveyed via search excerpts). React reconciler for agents; compaction control; `cache` markers to protect prompt-cache prefixes.
- **OpenAI Responses API: conversation state & compaction** — https://developers.openai.com/api/docs/guides/conversation-state, .../compaction (read via search + doc excerpts). `previous_response_id` (retained, server-side) vs replay-output-items (rebuild); server-side `/responses/compact`.
- **Anthropic context editing / compaction / memory tool** — https://platform.claude.com/docs/en/build-with-claude/context-editing (read excerpts). Server-side clearing of old tool results/thinking with placeholder substitution; cache-invalidation economics (`clear_at_least`); `compact_20260112` typed compaction blocks.
- **Vercel AI SDK** — known material: no render loop at all; `generateText`/`streamText` with a messages array the caller assembles each call — the degenerate immediate-mode harness. Its `ai/rsc` (`streamUI`) applies RSC streaming to *output* UI, not to context construction.

## 3. Mapping to LLM agentic loops

### 3.1 Retained vs immediate context: the survey

The chat APIs are stateless functions: every call receives the full context. So "the transcript is append-only" is not a physical constraint — it is a *convention* chosen for two reasons: (a) the model's coherence depends on seeing a stable narrative of what it previously said and did, and (b) prompt caching bills by stable prefix, so appending is nearly free while editing anything invalidates the cache from that point down. Harnesses split cleanly on this:

- **Retained/append** (Claude Code, our kernel, most production harnesses): the transcript is the retained tree; you only ever append. Notably, Anthropic is *adding mutation affordances to the retained model*: server-side context editing clears old tool results and replaces them with placeholders — the model is told content was removed — and server-side compaction substitutes a typed summary block. These are commit-phase operations on the transcript, priced in cache invalidation (`clear_at_least` exists purely to make the cache-break worth it). The retained world is growing a real "commit" API.
- **Immediate/rebuild** (agentick, AIDK, agentry, raw AI SDK): the context is compiled fresh every tick from a component tree. agentick's slogan is exact: "only what you render gets sent to the model" — `<Timeline>` takes a render function, so history is *rendered*, not replayed; old images become `[Image: beach sunset]`, old tool results collapse, and none of it is an append — it is this tick's projection. The cost is cache hostility (agentry adds `cache` boundary markers to claw prefix caching back) and the risk of gaslighting the model (its own past words silently rewritten).
- **Both** (OpenAI Responses): `previous_response_id` is fully retained server-side (you send only the new message); replaying output items is fully immediate (you own and may rewrite the array); server-side compaction serves both. The API explicitly warns not to mix the modes.

Our head-freeze + situation-diff is a **hybrid**: the head and transcript are retained (append-only, cache-aligned); the *stance* is immediate-mode — re-rendered every tick like an agentick tree — but its delta is delivered as an append rather than an edit. This is the right adaptation *given cache economics and model coherence*, with one honest caveat: React's diff is applied by the framework to a DOM that has no memory; our diff is applied by *the model's attention* to its belief state ("latest supersedes"). Reconciliation is delegated to the reader. That is not a flaw to engineer away — updating a mind by restatement is the only mechanism any messaging channel offers — but it means every superseded situation still sits in the window costing tokens and residual confusion. The natural completion of the design is a compaction/context-editing Layer that clears superseded `<situation>` messages once a newer one lands (Anthropic's `clear_tool_uses` analog, applied to our own message class), paying the cache break only when `clear_at_least`-style thresholds make it worthwhile.

### 3.2 What the JSX-agent frameworks actually demonstrate

Three things worth taking seriously, independent of JSX:

1. **The transcript as a rendered projection.** agentick's `<Timeline render>` is the genuinely new power relative to our kernel: compaction, redaction, and summarization become *rendering decisions* re-evaluated every tick. Our doctrine already assigns memory/compaction to kernel-implementation Layers (KernelMemory's JSDoc: "memory, compaction … are COMPONENT Layers a particular kernel implementation requires") — the survey confirms that is the right seam, but says the Layer should be structured as a *projection function over the transcript*, not an occasional destructive rewrite.
2. **Model-visible state with model-writable knobs.** agentick's knobs/accordion pattern (sections rendered collapsed; the model expands what it needs via a `set_knob` tool; `momentary` auto-collapse) is pull-based context: volatile or bulky data is *offered*, not pushed. This composes perfectly with an append-only transcript because the expansion arrives as a tool result — a natural append — rather than an edited block.
3. **Between-tick hooks as the control plane.** `useOnTickEnd`/`useContinuation`/gates are how these frameworks express budget stops, output verification, and forced extra turns. We express the same things today as charter branches + `settle` from the outside; the hook framing suggests a kernel-level seam (per-tick middleware) rather than more charter vocabulary.

Also worth noting what they get wrong for our purposes: both AIDK and agentick put *behavior in the tree* (components with lifecycle, signals, forks) and inherit the full hooks discipline — call-order rules, reconciler complexity, a runtime that cannot be serialized because closures are pinned in fibers. They are session-scoped in-memory engines; nothing about a fiber tree survives a process restart. For a durable kernel that is disqualifying as an architecture, even while individual patterns are worth stealing.

## 4. Comparison with alchemy's charter/stance/kernel model

**Where the analogy is load-bearing.** The charter's turn is a render: pure-ish (reads locals, no writes), re-evaluated before every sampling, discardable, cheap. `Fragment` is an element tree: immutable data (`template` + `refs`), produced fresh each tick, diffed by the kernel. `AI.local` is `useState` with the hooks trap consciously removed: identity comes from the construction site (a Symbol allocated in init), not call order — this is exactly Abramov's "keys" alternative *made safe* because allocation happens once in init, so there is no per-render call-order problem and custom composition (a helper that allocates several locals) cannot collide. Mailbox draining (`Queue.clear` into one tick) is React's event batching. Mention-is-presence is conditional rendering of capability. These correspondences are real and they earn their keep: the reason the Issues charter is readable is the same reason a React component is readable — the whole current stance is derivable from state by reading one function, instead of being the accumulated residue of imperative mutations.

**Where it misleads.** Three places:

1. *The render target has memory and a mind.* React can re-render arbitrarily because the DOM does not remember previous frames. The model remembers every frame (the transcript) and *integrates* them. "Just re-render" can contradict what the model was previously told; narrative consistency is a constraint React has no analog for. Our head-freeze is actually a stronger invariant than React offers — React happily rewrites everything; we promise the model its constitution never changes. That is a communication-theoretic decision, not a rendering one, and it is correct.
2. *Commit is not idempotent.* Writing the same props twice to the DOM is free; delivering the same situation twice costs tokens and attention forever. Hence `lastSituation` dedupe — which is right — and hence the bugs below, which come from the dedupe being keyed on text alone.
3. *The expensive phase is inverted.* React's render is expensive and commit cheap; our turn render is microseconds and the "commit" (sampling) is seconds and dollars. Fiber's interruptible-render machinery therefore has no direct analog — you cannot pause a sampling and reuse half of it. What transfers is the *scheduler above* the unit of work, not the sliced unit of work itself (§5.4).

**Concrete divergences found against the code:**

- **The A→B→A oscillation is a live bug.** In `KernelMemory.actorTick`: situation = blocks not in the frozen head; delivered only `if (situation.length > 0 && situation !== run.lastSituation)`. Take the Issues charter: tick 1 head contains the *triaging* block. The run parks → situation "awaiting-author…" delivered. The author replies, `resume_triage` fires → next tick's blocks are all in the head → situation is `""` → the guard skips delivery and `lastSituation` still holds the parked text. The model's most recent environmental statement says the issue is parked, forever. React would have restored A in the DOM; our kernel must *announce the restoration*. (In practice the tool result "resumed" partially covers this specific case, but only because the state change happened to originate from the model's own tool call; a `steer`-driven or time-driven return to baseline gets no announcement at all.)
- **Parametric blocks are situation spam.** Any block interpolating a timestamp, counter, or queue depth changes text every tick and re-delivers every tick. React survives volatile props because commit diffs per-node and mutates in place; every distinct text here is a permanent append. There is no way to fix this with keys alone — the fix is to keep volatile data out of the pushed stance entirely (§5.3).
- **Text-identity collisions are harmless — today.** Two branches emitting identical text are indistinguishable to the diff, and that is fine *because no state attaches to blocks*: locals are run-scoped, so React's reason for keys (deciding which state to preserve) has no referent. Keys become necessary exactly when either (a) per-block state/effects arrive, or (b) a context-editing commit path arrives that needs to find and replace a specific prior message (§5.2). Adding `AI.prose.keyed` today would be speculative machinery.
- **Preserve/reset: our answer is right, and it is not React's.** React resets a child's state when its identity at a position changes, because tree position is the identity of "the thing." Our unit of identity is the *run* (world-keyed: `owner/repo#7`), and locals persist across stance branches because the branch is a *view* of the run, not a thing with a life of its own. A parked issue's accumulated phase must survive the parked branch disappearing. The React-equivalent statement: all our state is hoisted to the root component, and the root's key is the run key — new key ⇒ fresh everything, which is exactly `admit`'s behavior. The cost of the hoisting: a reusable sub-charter (component) cannot own private state; anyone writing `const triage = (phase: Local<Phase>) => AI.prose\`…\`` threads handles manually. That is Props-drilling, and it is acceptable at current scale; if it hurts later, the fix is *scoped locals* (a local allocated per keyed subtree), which imports reset semantics — do it only with the key machinery, or not at all.

## 5. Steal / adapt / reject

### 5.1 STEAL — announce baseline restoration (bug fix, no new API)

Track whether a situation is outstanding; when the dynamic delta returns to empty, deliver one closing restatement instead of silence:

```ts
// KernelMemory.actorTick, replacing the tail:
const situation = stance.blocks
  .filter((block) => !run.head!.blocks.has(block))
  .join("\n\n");
if (situation !== (run.lastSituation ?? "")) {
  run.lastSituation = situation;
  return {
    system: run.head.text,
    toolkit,
    inject: situation.length > 0
      ? situation
      : "The prior situation no longer holds; the original instructions above apply unchanged.",
  };
}
```

One-line semantics change: the diff target is "last delivered dynamic state" (initially empty), not "non-empty and different." This is precisely React's *your last commit is the baseline* rule, adapted to append-delivery.

### 5.2 ADAPT — superseded-situation compaction as a kernel Layer

Old `<situation>` messages are dead weight the moment a newer one lands. A durable/production kernel Layer should clear them the way Anthropic's `clear_tool_uses` clears tool results — replace with a one-line placeholder, batched so the cache break is amortized (`clear_at_least` discipline). This is the *only* place block keys earn their existence: to edit a prior message you must know which prior message a new situation supersedes. If and when this Layer is built, introduce identity at the *situation* granularity (the kernel already has it: `lastSituation` per run) — still no per-fragment keys needed. Keep `AI.prose.keyed` out of the public API until a second consumer appears.

### 5.3 ADAPT — pull, don't push, volatile data (the knob pattern)

Ban timestamps/counters from stance prose by convention, and give charters the idiomatic alternative: an inline tool the model calls when it needs the current value — the expansion arrives as a tool result (a natural, cache-friendly append), and costs tokens only on demand:

```ts
const charter = Effect.gen(function* () {
  const queueDepth = yield* AI.local(0);
  const checkQueue = AI.Tool("check_queue")`
Current depth of the intake queue.`(() =>
    Effect.map(queueDepth.get, (n) => `${n} items waiting`));
  return AI.prose`
Work the intake queue; ${checkQueue} whenever you need the current depth.`;
});
```

This is agentick's knobs/accordion insight without any new kernel machinery — mention-is-presence already implements "collapsed section, expand on demand."

### 5.4 ADAPT — lanes across runs, not fibers within a turn

Turn evaluation is too cheap to slice; the model call is the frame budget. What Fiber teaches is the layer *above*: pull-based, prioritized admission of samplings across many runs sharing one model (rate limits, token budgets). Serial-per-run is forced by transcript coherence and must stay; the scheduler seam is where `step` acquires the model:

```ts
export type Lane = "interactive" | "default" | "background";

export interface ModelSchedulerService {
  /** Acquire a sampling slot; higher lanes preempt queued lower ones. */
  readonly sample: <A, E>(
    lane: Lane,
    step: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
}
export class ModelScheduler extends Context.Service<
  ModelScheduler, ModelSchedulerService
>()("alchemy/AI/ModelScheduler") {}
```

Lane assignment falls out of the actor verbs: `dispatch` (a caller is blocked) = interactive; `send`/`steer` from world events = default; periodic reconciliation of perpetual processes = background. Two React details transfer exactly: *expiration* (a starved background run is promoted — a perpetual process must not be starved forever by a chatty interactive agent) and *batching* (already present: the mailbox drain coalesces all pending inputs into one sampling). This is a Layer around `KernelMemory`'s `step`, not a kernel rewrite — consistent with the "everything else is a Layer" doctrine.

### 5.5 REJECT — Suspense; adopt per-run memoized data instead

Sampling with stale-or-fallback data is actively harmful: the model *acts* on what it reads; a fallback is not a spinner, it is misinformation. The latency argument also fails — a fetch is usually two orders of magnitude cheaper than the sampling it would unblock. What the turn does need is *cheap re-evaluation*: today an `Effect`-valued splice re-runs every tick, so a fetch in the stance is N fetches per conversation. Steal `useData`'s cache shape, not its throw-a-promise mechanics:

```ts
/** Per-run memoized effect: runs once per run (or per TTL window). */
export const memo = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: { readonly ttl?: Duration.DurationInput },
): Effect.Effect<Effect.Effect<A, E, R | CurrentRun>> => /* init-phase
  allocation, value cached in run.locals keyed by construction site,
  re-fetched when TTL lapses — the turn stays cheap and deterministic
  within a window */
```

### 5.6 STEAL (from RSC) — the serialization boundary for the durable kernel

`Fragment` is already an RSC payload in miniature: pure data, capability terms as *named references* (tags resolved from context at compile time), never closures — except for one hole: inline `ToolImpl`s close over locals and are unserializable. RSC's discipline says that is fine *as long as the tree itself is never what you persist*: RSC re-renders from code + data on every request; the payload is transport, not storage. The durable-kernel corollary: **persist `(runKey, locals, transcript)` and re-derive the stance by re-running init + turn on rehydration** — the charter is code (like a server component), the run state is data, and the closure hole never needs to be serialized because init deterministically reconstructs the same closures. This imposes two constraints worth adopting now, while they are cheap: (a) init must be deterministic (no ambient randomness feeding tool definitions); (b) `AI.local` values must be Schema-encodable — consider `AI.local(schema, initial)` as the durable-kernel variant. The head-freeze survives rehydration for free: the head is a function of the first tick's stance, which is a function of initial locals.

### 5.7 REJECT — JSX/component-tree runtime (AIDK/agentick architecture)

The whole reconciler apparatus — fibers holding closures, hooks with call-order identity, per-component lifecycle — exists to manage *retained per-node state*, which we deliberately do not have (locals are run-scoped; the stance is stateless projection). Importing it buys composition we already get from plain Effect functions returning `Effect<Fragment>`, at the price of unserializable runtime state (fatal for durability), hook rules, and a second scheduler. The one capability it has that we lack — transcript-as-rendered-projection — belongs in a kernel memory Layer (§5.2), not in user charters, per the existing doctrine that charters never see compaction.

## 6. Open questions

1. **Should the head ever un-freeze?** Caching makes the frozen head nearly free, but a perpetual process running for months accumulates situations against a constitution written on day one. Anthropic-style compaction blocks suggest a *re-head* operation: at a compaction boundary, re-render the current stance as a fresh head + summarized transcript (a new "first tick"). This is a full cache rewrite, so it wants the same `clear_at_least` economics — and it interacts with §5.6 rehydration (a rehydrated run could re-head naturally). Who decides when — kernel policy, or a charter-visible affordance?
2. **Situation granularity.** Today the situation is the concatenation of all non-head blocks, delivered as one message. Should independent dynamic aspects (phase instructions vs. a work-queue digest) diff and supersede independently? That is where per-block keys would return (§5.2's Layer would clear per-key rather than per-situation). Needs a real charter that hurts first.
3. **Cross-run render sharing.** Many runs of one term render nearly identical stances every tick. Turn evaluation is cheap, but tool compilation (`compileTool`, toolkit assembly) is redone per tick per run. React memoizes on `memoizedProps`; a stance-hash → toolkit cache is the analog. Measure before building.
4. **Scheduler fairness signals.** Lanes (§5.4) rank *kinds* of work; token budgets rank *amounts*. React's frame budget is uniform; ours is not — one background run can burn 100k tokens in a tick. Does the scheduler need cost-aware admission (estimate next-tick input tokens from head + transcript length) rather than pure priority?
5. **Is "latest supersedes" enough at scale?** The head coda teaches situation semantics once. After 50 situations, does instruction-following degrade relative to a re-headed (rebuilt) context? This is an empirical question worth a benchmark harness — it decides how aggressively §5.2/§6.1 matter.
