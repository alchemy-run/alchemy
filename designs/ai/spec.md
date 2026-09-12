# Alchemy AI: The Charter Spec

The specification for how agentic loops are authored and interpreted in
alchemy. Everything here was worked backward from DX (see
[agentic-loops.md](./agentic-loops.md) for the research synthesis behind it).

The design principle, stated once: **one re-entrant function controls
everything; everything else is stock Effect.** There is no charter DSL. The
loop-facing surface is:

```ts
AI.fragment`...`                                 // Fragment — the render output
yield* AI.Tool("name")`desc ${param}`(impl)   // inline tool (init) — closure over your refs
yield* AI.Dispatch(Agent, "name")`…`(derive)  // door (init) — policy-constrained delegation
yield* AI.say`...`                            // one-shot note (the event channel)
yield* AI.reply(value)                        // answer the current dispatch round (typed)
const thread = yield* AI.Thread               // the session: key, entries, tokens, compact, remind
(tick: AI.TickEvent) => Effect<Fragment>      // guard-tier turn: {count, inputs} as argument
return fragment                               // stance: keep working (turns return ONLY prose)
yield* Effect.fail(new AI.Refused({ ... }))   // typed give-up (error channel)
```

State is `Ref`. Branching is `Match`/ternaries. Observation is a fetch.
Caching is `Effect.cachedWithTTL`. Time is a Layer-owned schedule. Goals,
decorators, and compaction policies are userland functions.

See also: [driver-assembly.md](./driver-assembly.md) — the shipped
component map (Driver/DriverCore + the pluggable seams);
[deepseek-harness.md](./deepseek-harness.md) — the external
cross-reference against DeepSeek's harness.

---

## 1. The driver contract

```ts
// CHARTER — runs once per SESSION (the component instance / the "mount").
// Allocate state, define inline tools, resolve services. May fail (EInit
// is a defect — deploy-time error, not a runtime condition).
type Charter = Effect<Fragment | Turn | TurnFn, EInit, RInit>;

// TURN — re-entrant: evaluated before EVERY sampling and on every wake.
// Returns the STANCE and nothing else; answering a caller is the
// explicit AI.reply act (§9c), never a return value.
type Turn<E = any, R = any> = Effect<Fragment, E, R>;

// The GUARD tier: a function of the tick event — deterministic law
// over what-just-happened (budgets, refusals, pressure notes).
interface TickEvent<In = unknown> {
  readonly count: number;                 // samplings so far (the budget clock)
  readonly inputs: ReadonlyArray<In>;     // messages drained at this boundary
}
type TurnFn<In = unknown, E = any, R = any> =
  (tick: TickEvent<In>) => Effect<Fragment, E, R>;
```

The driver's behaviors are interpretations of the turn's result — charters
never name them:

| turn result | driver behavior |
|---|---|
| `Fragment` | the render IS the system prompt, verbatim → build toolkit → sample |
| an `Effect` | **loud defect** — you forgot `yield*` on an `AI.fragment` |
| any other value | **loud defect** — turns return prose; answer callers with `AI.reply` |
| failure (`E`), retryable | bounded recovery (backoff, honoring `retryAfter`); exhaustion abandons the ROUND, typed, to waiters |
| failure (`E`), non-retryable | the round abandons immediately — the typed error rides the error channel to waiters; the session keeps serving |
| `AI.Refused` failure | typed give-up, rides the error channel to waiters (a special case of the row above) |

Three tiers, static-first — climb only when the lower tier can't say it:

```ts
// 1. static prose — most agents (byte-stable system prompt, cache never busts)
export const ReviewerLive = Reviewer.make`
  You review each ${pr} against its originating ${issue} — the diff and
  the spec, nothing else. Verdict via ${Approve} or changes via ${Comment}.`;

// 2. a closure — inline tools, refs, bindings — returning a STATIC stance
export const EngineerLive = Engineer.make(Effect.gen(function* () {
  const openPullRequest = yield* AI.Tool("open_pull_request")`…`(…);
  return AI.fragment`…${openPullRequest}…`;        // Fragment → constant turn
}));

// 3. the GUARD tier — a function of the tick event, for laws the model
//    cannot be trusted to enforce on itself
export const EngineerLive = Engineer.make(Effect.gen(function* () {
  const stance = AI.fragment`…`;
  return Effect.fn(function* (tick: AI.TickEvent) {
    if (tick.count >= 60) return yield* Effect.fail(new AI.Refused({ … }));
    if (tick.count === 45) yield* AI.say`45 of 60 spent — converge.`;
    return yield* stance;                        // constant: cache intact
  });
}));
```

The guard sees the tick as an ARGUMENT (`count`, `inputs`) rather than an
ambient service — per-tick policy is a typed reducer from
what-just-happened to how-to-stand, testable as a plain function.
(`AI.Tick` remains available inside turns and tool handlers for `AI.say`.)

**Terms**: `AI.Agent` (bare Context tag, the ONE interpretable term),
`AI.Tool` / `AI.Parameter` (capability terms), `AI.Skill` (bare tag; a
dormant bundle whose TEACHING — prose + granted tools — lives on its
`make` Layer, so one contract can ship different teachings per
environment: `Coding.make` `` `${Grep} before ${ReadFile}…` ``),
`AI.Event` (message vocabulary). There is no Process term: a sealed
domain surface is a plain `Context.Service` whose Layer resolves a
PRIVATE agent's tag (provided by that agent's own `make` Layer) and
exposes only the declared Shape. The world still outranks the org:
`settle` from the implementation Layer always wins, and quiescence
still parks.

## 2. Prose

`AI.fragment` builds a `Fragment` and charges its splices' requirements to the
R channel (mention = dependency; capability-by-omission is a type-level
fact — on the output side too: the Layer's type carries the wire
surface the mentions produce, §2c-ii). Templates are **margin-stripped**
so prose indents with the code:

```ts
return yield* AI.fragment`
  This process manages issues for ${testAlchemy} from open to close.

  A ready issue is handed to ${Engineer}.
`;
```

Dedent rules (à la Kotlin `trimIndent`):

1. a leading blank first line is dropped;
2. margin = minimum indentation over non-blank **literal** lines (a line
   that runs into a splice counts — the splice is its content);
3. relative indentation beyond the margin is preserved (markdown nesting
   works);
4. splice values are never dedented and never influence the margin — a
   nested `AI.fragment` dedents itself.

Splice semantics at render (every tick):

| splice | renders as | grants |
|---|---|---|
| `Tool` term / inline `ToolImpl` | `` `name` `` | the tool, this tick |
| `Skill` term | `` `name` `` | access (activation via the `skill` intrinsic) |
| `Agent` term | name | the `dispatch` affordance, this tick |
| `Event` / `Parameter` | name | nothing (identity in prose) |
| nested `Fragment` / `Effect<Fragment>` | its blocks (evaluated per tick) | whatever it mentions |
| `Effect<string>` etc. | the value, inline | — |
| plain value | `String(value)` | — |

### 2a. The skill graph: teachings reference deeper skills

A skill's TEACHING may itself splice `Skill` terms — and activating
the parent EXPOSES them for activation. Access propagates one level
per activation: the charter's mentions are the roots; each tick the
driver walks the ACTIVE frontier to a fixpoint (cycles are fine), and
the reachable set is what the `skill` intrinsic offers. A depth-2
skill is invisible — not even named — until its parent activates.

```ts
export const CodingLive = Coding.make`
  Writing code in the checkout, with ${Grep}, ${ReadFile}, ${Bash}, …

  Deeper craft, when the work calls for it: ${ResourceEngineering} for
  resource providers, ${TypedErrors} for growing distilled's error
  unions, ${LiveTesting} for proving against the real cloud.`;
// Layer<Coding, never, …tools | ResourceEngineering | TypedErrors | LiveTesting>
```

This is progressive disclosure at arbitrary depth (the CLAUDE.md
"tree of files loaded at the right time", but typed): the Engineer's
charter mentions only `${Coding}`; a session that never touches resource
providers never spends a token on the Reconciler doctrine, and one
that does descends exactly as deep as the work demands. The child
tags ride the parent Layer's requirement channel, so an unprovided
doctrine is a COMPILE error, not a silent gap in the tree — and the
whole graph stays auditable the same way charters are (`rg
'\$\{ResourceEngineering\}'` finds every teaching that exposes it).

Composition note: the child implementations must be OUTPUTS of the
provided layer stack (`Layer.provideMerge`, not `Layer.provide`) so
the driver can resolve them from the interpret context at activation
time.

### 2b. Mention is presence — and there is deliberately no silent grant

**Decision (2026-07-23): a capability exists in a tick if and only if its
term renders in that tick's stance. There is no way to grant a tool
without rendering it, and none will be added.** This was challenged
("can you define tools that are not in the system prompt? that's what
frameworks do — define upfront, let the schema teach, keep the prose in
domain language") and examined; the challenge fails case by case:

- **Register** ("say *approve it*, never *use the approve tool*") is
  satisfiable inside the template — a mention is a word in a sentence,
  or a trailing line:

  ```ts
  // inline, colloquial — the mention IS the verb
  Reviewer.make`
    ${Approve} it, or send the author your exact ${Comment} — they
    hear your words, not a summary.`

  // trailing list — prose fully natural, grants explicit at the end
  Reviewer.make`
    Approve it or request the changes — the author hears your exact
    words.

    Your tools: ${Approve}, ${Comment}.`
  ```

  The trailing form costs ~3 rendered tokens per tool. That is the
  entire savings a silent grant would offer.
- **Bulk** (nine tools should not be narrated in every charter) is what
  SKILLS are: `${Coding}` is one mention granting a bundle; the
  individual tools arrive un-narrated at activation, and the place they
  are narrated is the skill's teaching, where narration is pedagogy.
- **"Not worth mentioning"** is a signal, not a problem: a tool that
  does not deserve six words of prose still costs its schema (~hundreds
  of tokens) in every request, and toolkit sprawl measurably degrades
  tool selection. Mention-as-cost is the pressure that keeps charters
  honest about what they carry.
- **Dynamism is where a silent channel actively breaks the design.**
  The stance TEXT is the source of truth and the render IS the system
  prompt, so a toolkit change always arrives with its explanation.
  Concretely, the Issues desk's turn renders its phase:

  ```ts
  return yield* AI.fragment`
    This process manages GitHub issues for ${testAlchemy} from open to
    close.

    ${Ref.get(phase).pipe(
      Effect.flatMap((phase) =>
        phase === "triaging"
          ? AI.fragment`
              …until the issue is READY, ${Comment} asks the author for
              exactly what is missing and ${awaitAuthor} parks the issue
              on them.`
          : AI.fragment`
              This issue is parked on its author. Judge their latest
              reply: when it closes the gaps, ${resumeTriage} and
              proceed; when it does not, ask again with ${Comment}.`,
      ),
    )}`;
  ```

  What the model actually experiences across the phase flip:

  ```
  tick 3 (triaging)   system prompt: …await_author paragraph…
                      toolkit: [comment, searchIssues, …, await_author]
    → model calls await_author; the handler flips the phase Ref;
      the TOOL RESULT ("parked; the author's next reply resumes this
      issue") announces the transition in the thread

  tick 4 (parked)     system prompt: …parked paragraph… (replaced whole)
                      toolkit: [comment, …, resume_triage]
  ```

  `await_author` is gone AND the text that removed it is the current
  system prompt — the same render produced both, so they cannot
  disagree. With a silent grant channel the toolkit could change while
  the stance text stayed identical: no trace — exactly the "do I have
  tool x?" confusion this design exists to prevent. Rendering is not
  decoration; it is the observability of capability, for the model and
  for anyone auditing the transcript.
- **The audit property**: `rg '\$\{Approve\}'` enumerates every charter
  that could ever hold that authority, and the type system agrees
  because the mention IS the requirement. A second, non-rendering grant
  syntax forks that story for a three-token savings.

The reductio: "tools defined here, prose over there" is the first plank
of the config-object design (tools array + separate system prompt) that
the template bet rejects. Reading the prose IS reading the capability
manifest — one artifact, colloquial on purpose.

The one legitimate concern found nearby is WIRE-level, not semantic:
per-tick toolkit changes churn the provider's tool-block cache. That is
the **union-toolkit + stance masking** transport (SHIPPED; §13):
unmentioned tools stay in the provider payload and are rejected on
call — bytes change, the law does not.

### 2c. The wire seam: `Tools` and codemode

Direct tool-calling loses what agents are best post-trained on: writing
CODE that composes primitives (Bash pipes are the canonical case). It
gains granular access control. Codemode keeps both: the model writes a
program; the ONLY functions in scope are this tick's granted handlers.

**`Tools` is an optional service the driver resolves from the
interpret context** at every sampling boundary. Absent: every mention
is its own provider tool (the default, unchanged). Present: the engine
transforms the tick's mentions (`ToolMention[]`) into their wire
presentation. Semantics never move — the stance still decides WHAT
exists (mention-is-presence, §2b); the engine decides how it APPEARS.
Driver intrinsics (`dispatch`, `spawn`, `skill`) stay direct tools in
every engine: they are conversation control, not capabilities.

```ts
// swap the wire without touching a single charter:
IssuesLive.pipe(Layer.provide(AI.CodeModeEffect()))  // programs return Effects
IssuesLive.pipe(Layer.provide(AI.CodeModeAsync()))   // async/await + Promises
// provide neither: direct tool-calling
```

Both codemode Layers collapse the mentions into ONE `eval` tool whose
description carries the convention's own TEACHING (how to write the
code) plus GENERATED SIGNATURES:

```ts
// from each mention's parameter schemas and its RETURN schema:
declare function readDiff(input: { pr: { owner: string; … } }): Effect<string>
```

The return type comes from the Tool's optional second argument —
`AI.Tool<ReadDiff>()("readDiff", S.String)` — undeclared means
`unknown`. Direct mode barely needs return schemas; codemode is why
they exist.

`CodeModeEffect` is the native flavor: the code is the body of a
function `(Effect, tools) => Effect<A>`, tools are Effect-returning,
and the whole program runs ON THE DRIVER'S FIBER — interruption,
tracing, and typed tool failures all compose (`Effect.forEach` for
concurrency, `Effect.catch` for recovery). `CodeModeAsync` bridges each
handler through `runPromise` for models that write better `await` code.
Failures are model-visible either way: a broken program or a failed
tool call comes back as the eval result, never a loop crash.

v0 evaluation is IN-PROCESS (`new Function`, TypeScript stripped by
`Bun.Transpiler`) — a composition seam, not an isolation boundary. The
sandbox-as-service extraction (§13) replaces the evaluator without
touching this contract, and exposing `thread`/a sub-model through the
same bridge is the RLM configuration.

### 2c-ii. The wire surface as a TYPE — consumers prove coverage

Mention-is-presence holds in the type system through the R channel
(§2): every `Tool<Self>` class the prose splices rides the `make`
Layer's requirement channel (its physics must be provided), and the
wire surface is read LAZILY from that channel — nothing is computed or
branded at layer construction. Consumers type against the un-provided
`make` result (`Layer.provide` consumes the requirements the surface
is read from). Inline `ToolImpl`s and doors carry no tag and are
runtime-only: a tool that wants compiler-checked coverage is a
`Tool<Self>` class.

The driver exposes only the FACTS — `AI.ToolNames<L>` (a union of
literal names) and `AI.ToolInput<L, Name>` (that tool's parameter type,
from its `Parameter` splices). What a consumer builds on them is
USERLAND: a transcript UI derives its own registry contract and gets
renderer coverage checked the way `Layer.provide` checks services —

```ts
// ui — type-only import (erased at build; no server code in the bundle)
import type { ReviewBotLive } from "../src/ReviewBot.ts";

type Renderers<L> = {
  [N in AI.ToolNames<L> & string]: (input: AI.ToolInput<L, N>) => ToolCallView;
};

const REVIEW_BOT: Renderers<typeof ReviewBotLive> = { … };
// forget a card → `Property 'sync_checkout' is missing in type …`
// touch a field the tool doesn't have → won't compile
```

Encapsulation mirrors §2's requirement rules: a SKILL's tools ride the
skill's own `make` Layer, never the host agent's wire type — the UI
composes one typed pack per layer (`Renderers<typeof CodingGeneral>`
beside the agent's) and spreads them into its lookup table. Note that
`Layer.provide` (binding physics) returns a plain Layer: packs type
against the `make` result, the teaching itself. Driver intrinsics
(`dispatch`, `spawn`, `skill`) are conversation control, not
capabilities (§2c) — they are OFF every agent's wire type; their cards
are the consumer's untyped remainder.

### 2d. Writing prose: the context-engineering doctrine

Frontier-model context engineering converged (Anthropic, "The new rules
of context engineering", 2026-07) on lessons this design mostly enforces
structurally; where it doesn't, they are AUTHORING doctrine for
charters and skills:

- **Situation over rules.** State the situation that motivates a
  behavior and let the model derive it, instead of legislating the
  behavior. The Reviewer's charter says *"there is no author to talk
  to, and your words are relayed once"* — not *"never ask questions;
  one pass, ALWAYS"*. Rules accrete during debugging as workarounds
  for a weaker model's judgment; each one is a standing tax (the model
  reconciles overlapping directives every tick) and a wrong answer for
  some inputs. Audit charters the way Anthropic audited its system
  prompt: delete every directive the situation already implies.
- **Never restate the type system.** Capability-by-omission is a
  type-level fact — prose like "you do not merge" in a charter with no
  merge grant restates what the tool surface already makes impossible.
  Say where the authority lives if it helps orientation ("review and
  merge are someone else's job"), not what the agent "must not" do.
- **Tool descriptions own tool usage.** A `Tool`'s template is its
  single teaching site; parameter schemas (enums, defaults, optional
  keys) are behavior hints stronger than examples. A skill's teaching
  carries only the CROSS-tool discipline no single description can
  (read-before-edit digest chains, verify-after-edit, output paging) —
  never per-tool narration. Repetition between charter, skill, and
  tool description is the conflict-generating pattern the audit
  removes.
- **Interfaces over examples.** Examples anchor exploration to the
  example's shape. Prefer expressive parameter design; codemode (§2c)
  is the strong form — generated signatures ARE the interface, and the
  model composes them as code.
- **Progressive disclosure is the architecture, twice.** Model-pulled:
  a skill mention is ACCESS, its teaching enters context only at
  ACTIVATION (the `skill` intrinsic). Author-pushed: the turn is code —
  a fragment can render only in the phase where it earns its tokens.
  Charters should lean on both instead of front-loading; a teaching
  needed in every tick belongs in the charter, one needed sometimes
  belongs in a skill, one needed rarely belongs in a workspace file
  the agent reads.
- **Skills encode taste, not process — except where process IS the
  product.** The best skills carry opinions particular to this org
  (the Reconciler shape, the Typed Error patch flywheel, the speed
  doctrine). Load-bearing procedure is legitimate constraint; style
  preferences dressed as procedure are not.
- **Rich references beat prose specs.** The strongest context is code
  the model already reads natively: acceptance criteria as the rubric,
  a test suite as the spec, a typed artifact (`achieve`, §6) as the
  outcome. Prefer splicing a reference (issue, diff, file) over
  summarizing it.
- **Prose is a per-model dial.** These lessons assume frontier
  judgment. The charter is a LAYER: a term bound to a small model may
  legitimately carry tighter rules than the same term bound to a
  frontier one. Rule density is a property of the binding, not the
  contract — which is exactly why prose lives on Layers and not on
  declarations.

## 3. State is `Ref`

The charter's init closure is the instance; there are no hooks because
there is a constructor:

```ts
const charter = Effect.gen(function* () {
  // INIT — once per session
  const phase = yield* Ref.make<"triaging" | "awaiting">("triaging");
  const awaitAuthor = yield* AI.Tool("await_author")`
    Park this issue on its author. ${Comment} your questions first.`(() =>
    Ref.set(phase, "awaiting").pipe(Effect.as("parked")));
  const resume = yield* AI.Tool("resume_triage")`
    The reply closed the gaps.`(() =>
    Ref.set(phase, "triaging").pipe(Effect.as("resumed")));

  // TURN — per tick; branching is a ternary, reading is Ref.get
  return Effect.gen(function* () {
    return yield* AI.fragment`
      This process manages issues for ${testAlchemy} from open to close.

      ${(yield* Ref.get(phase)) === "awaiting"
        ? AI.fragment`Parked on the author. When their reply closes the gaps, ${resume}.`
        : AI.fragment`
          Check prior art with ${SearchIssues}; ${LinkIssues} + ${CloseIssue}
          for duplicates. Until ready, ${Comment} asks and ${awaitAuthor}
          parks. A ready issue is handed to ${Engineer}.`}
    `;
  });
});
```

Declare outside the tick, mutate within — from the turn, from tool
handlers, from anything the closure hands out. No call-order rules, no
dependency arrays, no stale closures (`Ref` is read at use time).

Refs are **ephemeral by doctrine**: if the session must survive passivation,
derive the state from the world (level-triggering) or wait for the durable
driver's opt-in named-state variant. Don't tax every charter with naming.

## 4. `AI.Thread` and `AI.Tick` — driver facts + affordances

Two session-scoped `Context.Service`s. `AI.Thread` is the SESSION — identity and
conversation — provided to init, turns, and tool handlers alike: init runs
once per session at admit, when the thread already exists, so thread-scoped
setup (a checkout keyed by `thread.key`) belongs there. `AI.Tick` is the
current sampling iteration — no sampling is under way during init, so only
turns and tool handlers see it:

```ts
interface ThreadService {
  readonly key: string;                             // world identity (`o/r#7`) or minted
  readonly tokens: Effect<number>;                  // ESTIMATED thread size
  readonly entries: Effect<ReadonlyArray<Message>>; // READ-ONLY thread access
  /** Request compaction — applied by the driver at the next sampling
   *  boundary, never mid-assembly. Recorded; never silent. */
  readonly compact: (plan: CompactPlan) => Effect<void>;
  /** Answer the current dispatch round (behind AI.reply, §9c). */
  readonly reply: (value: unknown) => Effect<void>;
  /** Schedule a note to this session's future self (the driver clock, §9e). */
  readonly remind: (delay: Duration.Input, note: string) => Effect<void>;
}

interface TickService {
  readonly count: number;                           // samplings so far, this session
  readonly say: (note: Fragment) => Effect<void>;   // the collector behind AI.say
}

type CompactPlan =
  | { drop: (entry: Message, index: number) => boolean }  // → archived marker
  | { reset: { summary: string } };                       // fresh thread: head + summary
```

The thread stays driver-owned: `entries` is read-only and `compact` is the
one, boundary-applied mutation. That asymmetry is the design.

## 4b. The channels — every message traces to a call site

The design rule (learned the hard way — an earlier iteration DIFFED the
stance across ticks and injected the delta as driver-authored
"situation" messages, which worked but made the context window emergent
rather than legible): **the driver authors no messages of its own.**
The context window an agent author reasons about is exactly what they
can point to in code:

| channel | semantics | authored by | delivery |
|---|---|---|---|
| **system prompt** | the turn's render, verbatim | the charter's returned `Fragment` | whole, every sampling; byte-stable when the render is static |
| **note** | events — happen once, never revoked | charter, `yield* AI.say` | on first appearance per thread, `<note>` |
| **tool result** | the outcome of an action, incl. transitions the handler caused | tool handlers | with the call |
| **steer** | the world's voice | Layer / tools / humans | immediately, as inputs |
| **reminder** | the session's own past voice | `Thread.remind` (§9e) | at fireAt, as an input (`[reminder] …`) |

A CHANGED render simply replaces the system prompt (cache bust, on the
author's head) — no diff, no derived message. Keep the prompt static
and holistic (state every phase's rules; the conversation carries which
phase is live) and it behaves exactly as anyone would guess; a tool
handler that flips a phase announces the flip in its own RESULT.

`AI.say` is a PLAIN append — no dedupe, no memory, no driver judgment.
Calling it is delivering it, so the author's condition IS the delivery
policy, exactly like any other side effect:

```ts
return Effect.gen(function* () {
  const { count } = yield* AI.Tick;
  if (count === 30) {
    yield* AI.say`30 of 40 samplings spent — converge now.`;
  }
  return yield* AI.fragment`…stance…`;
});
// tick 30:  <note>30 of 40 samplings spent — converge now.</note>
// tick 31+: silent — the `===` guard already said it
```

An unguarded `say` delivers every tick — occasionally what you want,
usually a bug you can see at the call site. (One driver courtesy: a
turn attempt that FAILS and retries has its collected says discarded,
so transient retries never double-deliver.)

Rules: notes **grant nothing** (a `${Tool}` in a say renders as a name;
the toolkit comes from the stance alone — capability must never be a
function of the thread); notes land in emission order; a compaction
`reset` wipes them with the rest of the thread — anything that must
survive a reset belongs in the summary or gets re-said by authored
code.

## 5. Observation: never fetch raw per tick

The ladder, all stock Effect:

```ts
// (a) your own actions: the tool records the fact — free
const opened = yield* Ref.make<Pr | undefined>(undefined);
const openPullRequest = yield* AI.Tool("open_pull_request")`
  Open the pull request citing ${issue}.`((params) =>
  open(params).pipe(Effect.tap((pr) => Ref.set(opened, pr))));

// (b) others' actions: the Layer steers you; the payload IS the fact — free

// (c) must poll: cache in init — at most one call per TTL window
const issue = yield* Effect.cachedWithTTL(github.get(key), "2 minutes");

// (d) fleet scale: ONE poll fiber in the Layer, runs read memory
//     (SubscriptionRef<Map<key, Snapshot>> provided as an ordinary service)
```

**Materiality is userland discipline**: render only fields that should wake
the model — no timestamps, no etags — and an unchanged world produces an
unchanged stance, which the driver re-parks without sampling.

## 5b. Workspaces: the checkout as a capability

A coding agent needs a repository checked out somewhere it can work. That
"somewhere" is a capability like any other — one contract (`Git.Checkouts`),
physics chosen by the Layer:

```ts
// init: the binding, like any other capability
const checkouts = yield* Git.Checkouts;
const remote = GitHub.remote(testAlchemy);   // provider → Git, never the reverse

// init is per-session — the thread exists at admit, so the checkout is
// thread-scoped SETUP the turn and tools close over
const { key } = yield* AI.Thread;
const ws = yield* checkouts.checkout({ key, remote });

return Effect.gen(function* () {
  return yield* AI.fragment`
    …your checkout lives at ${ws.path}; every file you touch lives under it…`;
});
```

The laws:

- **Idempotent by key.** `checkout` with the same key returns the same tree —
  acquired once in init, and a tool handler that derives the same key
  (`yield* AI.Thread` in the handler) lands in the exact tree the session
  works in. No workspace value is threaded through prose or params; the
  KEY is the address.
- **Isolated across keys.** Two concurrent sessions get two trees. What crosses
  agent/machine boundaries is the pushed branch, never a shared filesystem.
- **Layer-swapped physics.** `Git.CheckoutsWorktree` (local): one central
  blobless clone per remote, `git worktree add` per key. A clean-clone-per-key
  layer when isolation beats speed. A `Cloudflare.Artifacts` layer for
  containers: per-key forks mounted via artifact-fs, whose deploy-time half
  contributes its image statements (artifact-fs, fuse3) to the host Container
  through the binding contract — same seam as every other binding.
- **Credentials are the helper protocol.** `Git.Credentials` answers "who
  authenticates this remote?" per host; `GitHub.GitCredentials` answers
  github.com from the GitHub credential chain. Composition decides which
  helpers exist — exactly `~/.gitconfig`, as Layers.
- **Containment composes.** A sandboxed toolbox rooted at the workspaces
  root contains every tree; `ws.path` (root-relative) is what the prose
  hands the model, so the tools can reach the session's tree but not escape.

## 6. Exit, goals, budgets — patterns, not primitives

```ts
const EngineerCharter = Effect.gen(function* () {
  // init: per-session setup — bindings, inline tools
  const open = yield* OpenPullRequest;
  const openPullRequest = yield* AI.Tool("open_pull_request")`
    Open the pull request citing ${issue}.`(
    Effect.fn(function* (params) {
      const created = yield* open(params);
      yield* AI.reply(created.pr);   // ACHIEVE: the caller gets the artifact
      return `opened ${created.url}`;
    }));

  const stance = AI.fragment`
    You receive exactly one ${issue}. ${Coding} is your craft; when
    green, ${openPullRequest} citing the issue. You do not review or
    merge.`;

  // GUARD tier: the budget is a law, not a request
  return Effect.fn(function* (tick: AI.TickEvent) {
    if (tick.count > 40) {
      return yield* Effect.fail(new AI.Refused({
        loop: "Engineer", reason: "no green PR after 40 samplings",
      }));
    }
    return yield* stance;
  });
});
```

- **achieve** = `AI.reply(artifact)` at the site that observed success (a
  tool handler that just created the thing), never the model's claim.
- **maintain** = a session that simply never replies with an artifact —
  quiescent text answers each round; the session is perpetual either way.
- **refuse** = `Effect.fail(new AI.Refused(...))` — the evidence bar
  (repeat-observed blocker) is a counter ref, userland.
- The world can still `settle` first — it outranks; waiters then resolve
  with the settle outcome.

## 7. Compaction: driver mechanism, userland policy

The driver guarantees three things regardless of who triggers it: applied
at sampling boundaries only, recorded (never silent), drops leave an
archived marker. Policy has three triggers, all over the same affordance:

```ts
// (a) in the loop — the turn knows what's re-derivable
const thread = yield* AI.Thread;
if ((yield* thread.tokens) > 150_000) {
  yield* thread.compact({ drop: toolResultsOlderThan(20) });
}

// (b) model-triggered — an inline tool (self-authored summaries commit
// better); the handler yields AI.Thread when it fires — init never sees it
const handoff = yield* AI.Tool("handoff")`
  Summarize decisions, open threads, and blockers; your context restarts
  from your summary.`((p: { summary: string }) =>
  AI.Thread.pipe(
    Effect.flatMap((thread) => thread.compact({ reset: { summary: p.summary } })),
    Effect.as("compacted"),
  ));

// (c) declared — a userland turn-wrapper over the same call
const withCompaction = (at: number) => <O, E, R>(turn: Turn<O, E, R>) =>
  Effect.gen(function* () {
    const thread = yield* AI.Thread;
    if ((yield* thread.tokens) > at) yield* thread.compact({ drop: toolResultsOlderThan(20) });
    return yield* turn;
  });
```

The system prompt is never touched by compaction (the turn's render is
delivered whole at every sampling — standing state needs no restating);
`reset` restarts the thread from the summary note alone, and — because
the say log is thread-scoped (§4b) — still-true notes re-deliver into
the fresh thread on the next tick. Derivation-shaped processes (e.g.
Distilled) can reset at every park — the Reactor configuration.

## 8. Components: init → turn, fractally

A component is the charter shape at smaller scale. Three levels:

```ts
// 1. prose function — stateless vocabulary
const dedupePolicy = (repo: Repository) => AI.fragment`
  Check prior art with ${SearchIssues}. Duplicates: ${LinkIssues} to the
  original, ${Comment} the author, ${CloseIssue}.`;

// 2. dynamic fragment — an Effect splice, re-evaluated every render
const ciBanner = (ci: Ref.Ref<CiState>) => Effect.gen(function* () {
  const s = yield* Ref.get(ci);
  return s.red
    ? AI.fragment`CI is RED (${s.reason}). Restoring it outranks everything below.`
    : AI.fragment``;
});

// 3. stateful component — own refs + tools; init'd in init, spliced in the turn
const workingNotes = Effect.gen(function* () {
  const notes = yield* Ref.make("");
  const remember = yield* AI.Tool("remember")`
    Replace your working notes — decisions, open threads, blockers.`(
    (p: { text: string }) => Ref.set(notes, p.text).pipe(Effect.as("noted")));
  return Effect.gen(function* () {
    return yield* AI.fragment`
      ## Working notes
      ${(yield* Ref.get(notes)) || "(none yet)"}
      Keep these current with ${remember}.`;
  });
});

// host
const charter = Effect.gen(function* () {
  const notes = yield* workingNotes;              // component INIT
  return Effect.gen(function* () {
    return yield* AI.fragment`
      You manage issues for ${testAlchemy}.
      ${notes}                                    // component TURN, per tick
      ...`;
  });
});
```

Known edge: two instances of a tool-carrying component collide on tool
names (first mention wins). Convention, not machinery: components that
carry tools take a name parameter.

## 9. Subagents

```ts
// (a) prose-mentioned — the model decides; mention = the dispatch affordance
AI.fragment`A ready issue is handed to ${Engineer}, whose PR must cite it.`;

// (b) code-held — you decide; the tag resolves to the Actor in init,
//     and delegation policy is ordinary Effect composition
const engineer = yield* Engineer;
const handOff = yield* AI.Tool("hand_to_engineer")`
  Hand a READY issue to engineering. The ${issue} spec must stand alone.`(
  (p: { spec: string }) =>
    engineer.dispatch(p.spec).pipe(Effect.timeout("45 minutes")));

// (c) parallel fan-out — reads parallel, writes single-threaded
const survey = yield* AI.Tool("survey")`
  Ask several independent research questions at once.`(
  (p: { questions: string[] }) =>
    Effect.all(p.questions.map((q) => researcher.dispatch(q)), { concurrency: 4 }));

// (d) spawn — ambient intrinsic; prose SHAPES its use
AI.fragment`
  For broad file surveys, spawn workers with only ${Grep} and ${ReadFile} —
  one question each, never the whole task.`;
```

Component vs subagent vs skill: component = same thread, an *aspect* of one
conversation; subagent = fresh window, isolation, parallelism; skill = a
component the model opts into (dormant, activation returns its prose as a
tool result — cache-safe).

### 9b. Named agents vs anonymous workers — the role-justification test

**Decision (2026-07-25): keep both delegation primitives; roles are the
exception, spawn is the default.** This was challenged ("why have strict
identities like Engineer and Reviewer at all? just Skills, and let the
process spawn whatever subagents the task needs — identity-less
processes") and examined; the two primitives turn out to answer
DIFFERENT authority questions and neither subsumes the other:

- **`spawn` is capability ATTENUATION.** A worker receives a SUBSET of
  its spawner's stance (tools/skills handed over pre-activated), runs
  as a leaf, returns prose, disappears. It can never hold a power its
  spawner lacks — which is exactly what makes it safe to leave to the
  model's judgment, and exactly why it cannot implement separation of
  powers. A channel that could spawn its own "reviewer" would need
  `Approve` in its OWN stance first, at which point the two-key
  ceremony (one party records approval, another's merge ratifies
  against the ledger) is theater.
- **`dispatch` is capability AMPLIFICATION with containment.** A named
  agent has its own charter Layer — tools, skills, physics, budget the
  DISPATCHER DOES NOT HOLD. Disjoint authority needs identities to
  hang the disjoint charters on. And the audit story stays static:
  `rg '\$\{Approve\}'` enumerates every charter that could ever hold
  that power; with ad-hoc spawn composition it would degrade to a
  runtime question about what some process wrote into a task string.

A NAMED agent is warranted iff at least one holds:

1. **Disjoint authority** — it must hold a power its callers must not
   (Reviewer: `Approve` without `Merge`; the channel: the reverse).
2. **Fixed doctrine** — its charter is org policy that must not vary
   per dispatch (the review rubric; not the dispatcher's whim).
3. **Own physics** — its Layer carries a closure the caller cannot
   hand over: guard-tier budgets, reply-on-evidence tools (Engineer's
   `open_pull_request` replying with the PR the moment it exists;
   ResourceEngineer's 150-tick budget).
4. **Typed result** — callers depend on its dispatch resolving with a
   typed artifact, not prose (Engineer → `PullRequestRef`;
   ResourceEngineer → `ServiceReport`).

Everything else is a `spawn` with skills — do NOT mint a role per task
flavor; task flavor is what SKILLS are for. (Applying the test to the
org: ResourceEngineer initially smelled like "Engineer with different
skills", but it passes on 3 AND 4 — different physics, different typed
exit — so both roles stand. The test is the point: it prunes future
roles before they accrete.) Note also that `spawn` is a MODEL
affordance (an intrinsic in the agent loop); deterministic code
delegates by dispatching actors it holds — code cannot spawn.

Naming note: `AI.Agent` deliberately does NOT rename to `AI.Process`.
The AGENT is the interpretable charter (the loop); a PROCESS is a
sealed `Context.Service` whose Layer wires a private agent to the
world. Erlang/OTP landed the same way: registered names for the
processes that carry supervision or a service contract, anonymous pids
for ephemeral workers.

### 9b-ii. Missions are BINDINGS of a role — one tag, many charters

**Decision (2026-07-27).** A difference can live in three places, and
each answers a different question:

- **The contract (the tag)** — the ROLE: the verbs, the authority
  envelope (Engineer holds `${OpenPullRequest}`, never merge or
  approve), and the reply shape callers depend on (a PR reference).
  This is what the audit greps and what the role-justification test
  (§9b) gates.
- **The binding (a `Layer<Role>`)** — the MISSION: what a round of
  work is, what done means, the standing situation. "You work one
  issue's thread" and "you keep ./distilled tracking upstream" are
  different missions for the same role.
- **A skill** — the CRAFT: how to do something, pulled in when the
  work demands it. Skills cannot honestly redefine what a persona's
  rounds ARE — mission prose is the frame the skills hang off, not a
  teaching to activate.

The org's case: `DistilledMaintainer` failed the §9b role test (same
authority shape and typed result as Engineer — "Engineer with
different prose"), but its difference wasn't craft either. It was a
second MISSION, so it became a second binding:

```ts
export class Engineer extends AI.Agent<Engineer>()("Engineer") {}

export const IssueEngineer     = Engineer.make(/* one issue's thread */);
export const DistilledEngineer = Engineer.make(/* track upstream specs */);
```

Composition staffs each desk: the IssueOwner's subtree provides
`IssueEngineer`, the Distilled process's provides `DistilledEngineer`
— the driver resolves a charter's `${Engineer}` mention (and a door's
target) from THAT charter's own Layer graph, so both missions coexist
in one runtime. This is §2d's "prose is a property of the binding"
extended from model-dial to mission.

The guardrail the convention needs stated: **bindings may vary
mission, skills, and model — never the authority envelope.** A
`Layer<Engineer>` that splices `${Approve}` betrays the role; nothing
type-level prevents it, but the audit still works because it greps
charters per binding — the rule just has to be law.

### 9c. Call/reply, sessions, and the supervision cascade

**Decision (2026-07-25, refined 2026-07-26): answering a dispatch and
ending a session are DIFFERENT acts — and the answer is an explicit
`AI.reply`, from wherever the answer is actually produced.** The
original achieve pattern conflated answer with settle; the first
refinement kept the turn-return as the reply channel, which still
forced the artifact through a `Ref` dance (tool stores → next turn
returns → consume). The driver rules now:

1. **`AI.reply(value)` answers the round.** Callable from a tool
   handler (the natural site — the moment the artifact provably
   exists) or from turn code. Every pending dispatch waiter resolves
   with the value; the session neither parks nor ends — the model may
   keep working (wrap up, comment, start CI). A round that never
   replies answers with its quiescent text, the fallback. Turns
   RETURN ONLY PROSE; a non-Fragment return is a loud defect.

   ```ts
   const openPullRequest = yield* AI.Tool("open_pull_request")`…`(
     Effect.fn(function* (params) {
       const created = yield* open(params);
       yield* AI.reply(created.pr);   // ← the caller has its answer NOW
       return `opened ${created.url}`;
     }),
   );
   ```

2. **Waiters ride their inputs.** A dispatch's waiter joins the
   answerable round only when its own message is DRAINED into a tick
   — a dispatch that arrives while an earlier round's epilogue is
   still sampling can never be resolved by that round's reply or
   quiescent text. (Without this pairing, `reply` re-introduces the
   race the achieve pattern had.)
3. **Sessions on `dispatch`.** The intrinsic takes an optional
   `session` name; the driver derives a DETERMINISTIC child key
   namespaced under the dispatching session
   (`{parent.key}/{agent}/{session}`), so re-dispatching the same
   agent + session continues the SAME worker session via the existing
   admit-or-enqueue semantics. Back-and-forth is just calling again.
   Omitting `session` mints a fresh session — one-off labor. Namespacing
   means two issues' "build" sessions can never collide, and the
   audit story is unchanged: sessions alter memory, never authority.
4. **The supervision cascade.** The driver remembers each session's
   session workers (the dispatch parentage edge, now load-bearing):
   when a session settles OR crashes, its children settle with it. Parked
   workers never outlive the conversation that owns them. A crash's
   typed cause propagates to every waiter in the cascade — a
   supervisor's dispatch fails with the reason, not a stringly `Error`
   (§11b).

**Communication doctrine: workers speak PROSE (or a typed artifact)
to their supervisor, never to each other.** The supervising agent is
the message bus — it relays one worker's answer into another's next
task, with judgment applied at every hop (the channel relays the
Reviewer's verdict to the Engineer as a fix task, not a raw
forward). Serial or parallel is the supervisor's choice PER SAMPLING:
one `dispatch` call is serial; several dispatch calls in ONE sampling
run their workers CONCURRENTLY (tool-call execution is unbounded),
and every answer lands in the same message. Fan-out/fan-in is a
sampling shape, not a primitive.

Budget note: park-on-answer makes the tick count a LIFETIME counter
across rounds — budgets sized for one round must either grow (the
org's Engineer went 40 → 60) or gate on a per-round measure when one
exists.

### 9d. Doors: `AI.Dispatch` — policy-constrained delegation

A bare `${Engineer}` mention grants the GENERIC dispatch intrinsic:
the model chooses the task AND the session — full composition
authority, right for supervisors trusted with it. When the org has an
INVARIANT (one engineer per issue; reviews always resume the same
reviewer), the session choice must not be the model's to make.
`AI.Dispatch` builds a **door**: the delegation presented as the
org's own tool, its policy in code:

```ts
const HandToEngineer = AI.Dispatch(Engineer, "hand_to_engineer")`
  Hand one round of issue work to the engineer, with ${task} standing
  alone: issue reference and acceptance criteria verbatim.`(
  (p, thread) => ({ task: p.task, key: `${thread.key}/Engineer/build` }),
);

// in a charter's init:  const handToEngineer = yield* HandToEngineer;
// in its prose:         …a ready issue goes through ${handToEngineer}…
```

The split: **userland owns the presentation and the policy** (name,
prose, parameter schema, the `derive` deriving `{task, key}` — the
session invariant is enforced by ABSENCE: no session parameter exists
at the wire for the model to misuse); **the driver owns the
mechanism** (executes the dispatch, stamps parentage, registers the
child for the supervision cascade, emits the `dispatched` observation
carrying tool + agent + child key, so the UI links worker cards with
no heuristics). The policy may be an `Effect` returning the function,
so a module-scope door can pull its own dependencies (a `Ledger`,
config) — their tags ride the charter's R channel like any splice. A
policy failure is a model-visible tool result, never a loop crash.

Doors are deliberately NOT in the stance's tool set that `spawn`
grants from — workers are leaves; a spawn can never hand delegation
onward.

### 9e. `Thread.remind` — the driver clock

Time-based self-nudges (`"if the author hasn't replied in a day,
ping"`) previously required a Layer-level scheduler steering from
outside. Now the session can set them itself: `AI.Thread.remind(delay,
note)` schedules a note to the session's FUTURE SELF and returns
immediately — the note is data `(fireAt, text)`, delivered as an
ordinary inbox message when due: a wake if the session is parked by then,
a queued message if busy, dropped if settled. The driver owns the
clock, fused to the session's lifetime — a fiber on `DriverLocal` (runs
are process-lifetime there), a Durable Object alarm on a durable
driver — which is exactly why it is a driver method and not userland
`Effect.sleep`: a sleeping fiber inside a tool handler dies with the
isolate; the reminder must not.

Userland wraps it in an org-voiced tool (`remind_me`) and the charter
teaches WHEN (the org's patience policy is prose); scheduled events
arrive prefixed `[reminder] …` and are judged fresh — the situation
may have moved by the time one fires.

## 10. Layers, composition, testing

Requirements propagate through R and are discharged at composition:

```ts
// the desk's Shape is a plain Context.Service; the agent behind it is
// PRIVATE (un-exported), with its own default Layer
class IssuesAgent extends AI.Agent<IssuesAgent>()("Issues") {}
const IssuesAgentLive = IssuesAgent.make(charter);   // R: Engineer | Driver | ...

export const IssuesLive = Layer.effect(Issues, Effect.gen(function* () {
  const issuesAgent = yield* IssuesAgent;            // the loop, private
  yield* GitHub.consumeRepositoryEvents(testAlchemy, { events: [...] }, route(issuesAgent));
  return { list: ... };
})).pipe(Layer.provide(IssuesAgentLive));

const Org = IssuesLive.pipe(
  Layer.provide(Engineer.make(EngineerCharter)),     // or a DevBox-backed variant
  Layer.provide(DriverLocal),
  Layer.provide(MemoryLedger),
);

// tests: fake a whole agent with one Layer — no driver, no model
const FakeEngineer = Layer.succeed(Engineer, Engineer.of({
  dispatch: () => Effect.succeed({ pr: "…/pull/1" }),
  send: () => Effect.void, steer: () => Effect.void,
  settle: () => Effect.void, interrupt: () => Effect.void,
}));
```

`yield*`-in-init is eager (missing Layer fails at construction — deploy
error); prose mention resolves lazily at tick time. Same requirement.

Time and preemption live in the Layer, not the charter:

```ts
// TIME: a schedule that steers
yield* Effect.forkScoped(
  nudgeStale(github, issues).pipe(
    Effect.repeat(Schedule.spaced("6 hours").pipe(Schedule.jittered))));

// PREEMPTION: write state BEFORE steering — next tick's stance + toolkit
// change deterministically; the steer explains what already happened
Match.tag("CheckRunFailed", (e) =>
  Ref.set(ciRed, true).pipe(Effect.andThen(issues.steer(e.key, e))));
```

## 11. Driver behaviors (invisible to charters)

- **Per-run init**: the charter runs on first admission of a key; its
  closure is the session's instance. Distinct keys = distinct instances.
- **Channel delivery order**: per tick, notes in emission order; notes
  are user-role but delimited (`<note>`), the one contract taught in
  the system prompt's constant coda. The say log is thread-scoped
  (§4b).
- **The render is the system prompt**: delivered whole at every
  sampling, no diffing, no driver-authored messages. A static render is
  byte-stable (prompt-cache discipline); a changed render replaces the
  system prompt — legibility over cleverness, the cache cost is the
  author's choice.
- **$0 no-op tick**: an unchanged stance with an empty inbox re-parks
  without sampling (matters once resync/reminder wakes exist).
- **Steer to an unknown key admits** (crash-recovery: a re-polled event
  must never be silently dropped).
- **Round failures are typed, and retryability is honored** — see §11b.
  Transient provider errors recover with capped backoff and never poison
  a key; deterministic ones (billing, auth, content policy) abandon the
  round immediately with the typed error to waiters. Full supervision
  (quarantine, escalation, intensity) is an interpret option — deferred.
- **Quiescence parks; the world settles.** Unchanged.

## 11b. The error model: errors sort by who can act

An error's destination is decided by its AUDIENCE, never by where it
was thrown. Three lanes:

| lane | audience | mechanism |
|---|---|---|
| tool / door-policy failure | **the model** | `failureMode: "return"` — a model-visible tool result; the agent is the error handler. Never touches the driver's error channel. |
| round failure (sampling `AiError`, turn `E`, `AI.Refused`) | **the caller** | the round fails TYPED on the error channel — waiters (`dispatch`, doors, HTTP edges) receive the tagged error and `catchTag` it. The session keeps serving; the next event opens a fresh round. |
| infra defect (storage, RPC, driver bugs) | **the operator** | crash-and-recover: the busy-marker budget re-enters the round; exhaustion abandons it VISIBLY and fails waiters. |

Retryability is the error's own testimony, never the driver's guess:
effect AI's `AiError.isRetryable` (rate limit → yes; billing, auth,
content policy → no) decides whether a round failure enters recovery
or abandons on the spot. The driver adds NO retry the error itself
doesn't justify — `Effect.orDie` on a sampling is a spec violation:
it erases the typed error into the defect lane and condemns a
deterministic failure to pointless recovery. (This is exactly how the
org burned ~15 identical Anthropic calls on one billing error: a blind
3× retry inside the sampling step, times a 5-attempt recovery loop,
with the reason visible only in worker logs.)

"Fatal" always means fatal to the ROUND, never the session: the session parks
with its thread intact and the next event opens a fresh round. Account-
level conditions (billing) are handled emergently — every session fails its
round fast and typed, no retry storm; a global circuit breaker, if ever
wanted, is a `Models`-seam Layer concern, not a driver primitive.

The driver never RENDERS an error. The `crashed` observation carries
the ENCODED tagged error (`_tag`, `message`, retryability — stacks and
`Cause` wrappers stripped); projections, boards, and UIs own
presentation (userspace). The agent's own view of a failed round is
thread content: a note on the next wake ("the previous round failed:
<error> — it was not retried"), the same channel every other driver
fact uses.

## 12. Per-tick configuration (model, sampling params)

Everything that configures the *sampling itself* — model tier, temperature,
`tool_choice` forcing — is per-tick state, so it lives where per-tick state
lives: the turn's return, as pipeable Fragment annotations (the one
extension mechanism, per [notes-effect-native](./research/notes-effect-native.md)):

```ts
return yield* AI.fragment`
  Survey the failures across all 40 files and group them.
`.pipe(AI.model("fast"));            // cheap tier for bulk work

return yield* AI.fragment`
  Decide: merge or request changes. Cite the diff.
`.pipe(AI.model("default"));         // judgment gets the big model
```

- Tier names are resolved by a `Models` SERVICE the driver requires (the
  same seam pattern as `LanguageModel`/`Sandbox` — never driver
  constructor options): `Layer.succeed(Models, { fast: haiku, default:
  sonnet })` at composition; charters name tiers, never providers.
  Level-triggered like everything else: the tier is re-declared every
  tick, so it follows phases automatically.
- Deterministic capability (skills a phase should always have) needs no
  mutation either: render the content in the stance — a skill is prose +
  tools, and the stance owns both. The `skill` intrinsic remains the
  MODEL-managed working set (activation returns prose as a tool result,
  cache-safe); code-managed capability is just stance content.
- Not yet implemented: the annotation combinators and the multi-model
  registry. The mechanism (Fragment metadata the driver may read) is
  already load-bearing elsewhere.

## 13. Deferred designs — and what has since shipped

- **`AI.Workflow` — deterministic orchestration as a first-class session
  (designed 2026-07-27).** The taxonomy question every orchestration
  answers is *who owns the control flow*:

  | construct | control flow | durability | lifetime |
  |---|---|---|---|
  | router | none (event → key) | ledger dedupe | a subscription in a Layer — no term |
  | `AI.Agent` | the model's | the thread | a CONVERSATION: owned, cascaded |
  | `AI.Workflow` | code's | the journal | a JOB: autonomous, explicitly cancelled |

  A workflow is a session whose "turn" is a typed function instead of a
  sampling — same keyed sessions, verbs, waiters-ride-inputs, `remind`,
  observations, and board presence; different brain. The declaration
  carries the signature as a TYPE PARAMETER (no schemas, no prose —
  a workflow is never model-visible; a tool or door bridges that gap
  and carries the prose):

  ```ts
  export class ResourceWave extends AI.Workflow<
    ResourceWave,
    (wave: WaveSpec) => Effect.Effect<WaveReport, WaveRefused>
  >()("ResourceWave") {}

  // make: the function, or an init Effect returning it (init once
  // per session key — re-dispatch to the same key hits the same closure)
  export const ResourceWaveLive = ResourceWave.make(
    Effect.gen(function* () {
      const engineer = yield* Engineer;                 // INIT
      return Effect.fn(function* (wave) {               // BODY, per round
        const reports = yield* Effect.forEach(
          wave.services,
          (svc) => engineer.dispatch(taskFor(svc), { key: `${wave.id}/${svc}` }),
          { concurrency: 4 },
        );
        return { completed: reports.length };           // the typed reply
      });
    }),
  );
  ```

  Supervision semantics differ from agents ON PURPOSE (link vs
  monitor): a dispatched workflow is NOT registered in `session.children`
  — no cascade, no lifetime coupling. A half-done deterministic plot
  should finish or fail on its own terms, never die because the
  conversation that started it went quiet; subordination, where
  wanted, is an explicit `settle` by key in code. Attribution stays:
  the `dispatched` observation carries the child key for the UI card.

  Build when the first real deterministic plot lands (the factory
  wave over distilled services); durability semantics (journal +
  replay on a DO host) get decided against that use, not
  speculatively. Note `AI.Process` (a `{main, charter}` bundle) was
  CONSIDERED AND REJECTED here — it packaged a router with an agent,
  and bundles aren't semantics; routers stay plain Layers.

- Driver options: supervision (`restart`/`intensity`/`onGiveUp`), resync
  schedules, lanes + sampling token bucket, per-tool cooldowns, self-event
  filtering.
- **Durable placement: SHIPPED** as the Durable Object host
  (`Cloudflare/AI/DriverCloudflare.ts`) over the same `DriverCore`
  engine; the named-state variant of `Ref` shipped as
  `PersistentRef`.
- **Union-toolkit + stance masking: SHIPPED 2026-08-14**
  (dsh-informed; see [deepseek-harness.md](./deepseek-harness.md)):
  the direct wire carries the session's union of every tool ever
  mentioned, in first-mention order — the provider payload is
  byte-stable across phase flips — and a union tool the CURRENT
  stance does not mention rejects model-visibly. The SEMANTICS stay
  §2b's mention-is-presence, unchanged; an explicit `Tools` service owns
  the policy for its own presentation (codemode's single `eval` tool
  is stable by construction).
- **Request-envelope logging — SHIPPED 2026-08-14** (dsh's
  "model-visible means logged", adopted): every sampling appends a
  durable `stance` observation — envelope hash every tick, full
  snapshot (rendered prose + presented toolkit) when it changed — so
  any tick's request is reconstructable from `ThreadStorage` alone.
  Crash recovery likewise appends a typed `interrupted` observation
  (never emitted by a healthy round). Deferred residue: a runtime
  assertion that the sampled prompt equals the last logged envelope.
- **Compaction, the concrete design (recorded 2026-08-14, still
  userland policy per §7).** Three independent, log-replayable
  pressure valves, adopted from dsh's proven shape:
  1. **Spill at result time** — oversized tool output parked behind a
     preview + retrieval id; best-effort (a spill failure keeps the
     inline original, never fails the call). Shipped in userland as a
     `Tools` wrapper (`alchemy-org/src/lib/SpillingTools.ts`) — the seam
     already exposes every mention's handler, so no new core surface.
  2. **Deterministic tool-result pruning** — head/middle/tail shrink
     of oversized results, each replacement logged with the shadowed
     range, run BEFORE any LLM summarization.
  3. **Summary compaction as surface replacement** — the summary rides
     an ordinary message carrying a `replace` op citing the shadowed
     observation range; the model surface and the human transcript
     become two projections of one log (the transcript keeps reading
     the originals). Bracketed by lock observations whose orphaned
     start is crash evidence; tool-call/result pairing balanced across
     boundaries. Prerequisite: a `TokenMeter` seam anchored on real
     provider usage with per-node heuristic prices.
- **Self-inspection tools (deferred; the recursive-improvement
  precursor).** dsh's `cordis_inspect_*` pattern: before the agent
  authors changes to its own charters/Layers, give it tools that query
  the LIVE composition — seams present, tool schemas, event vocabulary
  — so self-edits are written against reality, not recall. Pairs with
  the approval gate for the apply step.
- **Codemode: SHIPPED as `Tools` Layers** (§2c) —
  `AI.CodeModeEffect()` / `AI.CodeModeAsync()` collapse the tick's
  mentions into one `eval` tool with generated signatures; evaluation
  is v0 in-process behind the **`Eval` seam** (`run({ modules, main,
  tools, timeout }) → { output, logs }`), with `EvalFunction` as the
  in-process default and `EvalWorkerLoader` for Cloudflare isolates.
  STILL DEFERRED: hardened local isolation (a subprocess `Eval`) and
  the RLM bridge. The evaluator is a **service, not a driver
  property** — the same seam pattern as `LanguageModel`:

  ```ts
  // the engine requires the seam; placements pick the physics:
  AI.CodeModeEffect()                                  // Layer<Tools, never, Eval>
    .pipe(Layer.provide(AI.EvalFunction))              // in-process (v0, composition seam)
    .pipe(Layer.provide(Cloudflare.EvalWorkerLoader))  // DO host: native isolates
  ```

  Exposing the thread and a cheap sub-model through the same bridge
  (`thread.grep(...)`, `llm(...)`) IS the RLM configuration — and
  because `Eval` is an ordinary service, userland can reach the same
  seam (an opt-in `eval` tool in a charter resolves `Eval` from
  context like any other capability). Engine chosen per term at Layer
  composition; switch at session start or compaction boundaries, not
  per tick.
- `spawn` context grants (pass-by-reference thread spans) + model tier.
- **Auto-memory: a library pattern, NOT a driver seam.** Both halves are
  ordinary userland: the write side is a granted tool (or plain
  `Workspace` file convention), the read side is an effectful splice in
  the turn (`${memory.recall()}`) — per-tick stance assembly IS the
  injection mechanism harnesses have to build as a feature. The
  compaction policy (author-owned, §7) is the natural distill-before-
  evict write point. Deferred work is only packaging: a reusable
  `Memory` service with swappable stores (workspace files, DO, R2).
- `AI.model`/sampling-param annotations + multi-model driver registry (§12).
- Whole-program head vs frozen-first-branch (empirical; needs a benchmark).
