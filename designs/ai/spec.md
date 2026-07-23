# Alchemy AI: The Charter Spec

The specification for how agentic loops are authored and interpreted in
alchemy. Everything here was worked backward from DX (see
[agentic-loops.md](./agentic-loops.md) for the research synthesis behind it).

The design principle, stated once: **one re-entrant function controls
everything; everything else is stock Effect.** There is no charter DSL. The
loop-facing surface is:

```ts
AI.prose`...`                                 // Fragment — the render output
yield* AI.Tool("name")`desc ${param}`(impl)   // inline tool (init) — closure over your refs
yield* AI.say`...`                            // one-shot note (the event channel)
const thread = yield* AI.Thread               // the run: key, entries, tokens, compact
const tick = yield* AI.Tick                   // this sampling: count
return fragment                               // stance: keep working
return value                                  // any non-Fragment: run settles from inside
yield* Effect.fail(new AI.Refused({ ... }))   // typed give-up (error channel)
```

State is `Ref`. Branching is `Match`/ternaries. Observation is a fetch.
Caching is `Effect.cachedWithTTL`. Time is a Layer-owned schedule. Goals,
decorators, and compaction policies are userland functions.

---

## 1. The kernel contract

```ts
// CHARTER — runs once per RUN (the component instance / the "mount").
// Allocate state, define inline tools, resolve services. May fail (EInit
// is a defect — deploy-time error, not a runtime condition).
type Charter = Effect<Turn | Fragment, EInit, RInit>;

// TURN — re-entrant: evaluated before EVERY sampling and on every wake.
type Turn<Out = unknown, E = any, R = any> = Effect<Fragment | Out, E, R>;
```

The kernel's behaviors are interpretations of the turn's result — charters
never name them:

| turn result | kernel behavior |
|---|---|
| `Fragment` | render stance → diff → deliver situations → build toolkit → sample |
| any other value | the run **settles from inside** with that value (waiters resolve with it) |
| an `Effect` | **loud defect** — you forgot `yield*` on an `AI.prose` |
| failure (`E`) | retried with backoff; persistent failure fails the run |
| `AI.Refused` failure | typed give-up, rides the error channel to waiters |

A static charter is the degenerate case — `AI.prose` **is** a valid charter
(a constant turn):

```ts
export const ReviewerLive = Reviewer.make`
  You review each ${pr} against its originating ${issue} — the diff and
  the spec, nothing else. Verdict via ${Approve} or changes via ${Comment}.`;
```

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

`AI.prose` builds a `Fragment` and charges its splices' requirements to the
R channel (mention = dependency; capability-by-omission is a type-level
fact). Templates are **margin-stripped** so prose indents with the code:

```ts
return yield* AI.prose`
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
   nested `AI.prose` dedents itself.

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
  The stance TEXT is the source of truth; stance diffs are delivered as
  situation messages, so a toolkit change always arrives with its
  explanation. Concretely, the Issues desk's turn renders its phase:

  ```ts
  return yield* AI.prose`
    This process manages GitHub issues for ${testAlchemy} from open to
    close.

    ${Ref.get(phase).pipe(
      Effect.flatMap((phase) =>
        phase === "triaging"
          ? AI.prose`
              …until the issue is READY, ${Comment} asks the author for
              exactly what is missing and ${awaitAuthor} parks the issue
              on them.`
          : AI.prose`
              This issue is parked on its author. Judge their latest
              reply: when it closes the gaps, ${resumeTriage} and
              proceed; when it does not, ask again with ${Comment}.`,
      ),
    )}`;
  ```

  What the model actually experiences across the phase flip:

  ```
  tick 3 (triaging)   toolkit: [comment, searchIssues, …, await_author]
    → model calls await_author; the handler flips the phase Ref

  tick 4 (parked)     the re-rendered stance differs; the kernel delivers:

      <situation>
      This issue is parked on its author. Judge their latest reply:
      when it closes the gaps, `resume_triage` and proceed; when it
      does not, ask again with `comment`.
      </situation>

                      toolkit: [comment, …, resume_triage]
  ```

  `await_author` is gone AND the text that removed it is the text that
  explains its absence — the same render produced both, so they cannot
  disagree. With a silent grant channel the toolkit could change while
  the stance text stayed identical: no diff, no situation, no trace —
  exactly the "do I have tool x?" confusion the reconciler exists to
  prevent. Rendering is not decoration; it is the observability of
  capability, for the model and for anyone auditing the transcript.
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
the deferred **union-toolkit + stance masking** kernel option (§13):
unmentioned tools may stay in the provider payload and be rejected on
call — bytes change, the law does not.

## 3. State is `Ref`

The charter's init closure is the instance; there are no hooks because
there is a constructor:

```ts
const charter = Effect.gen(function* () {
  // INIT — once per run
  const phase = yield* Ref.make<"triaging" | "awaiting">("triaging");
  const awaitAuthor = yield* AI.Tool("await_author")`
    Park this issue on its author. ${Comment} your questions first.`(() =>
    Ref.set(phase, "awaiting").pipe(Effect.as("parked")));
  const resume = yield* AI.Tool("resume_triage")`
    The reply closed the gaps.`(() =>
    Ref.set(phase, "triaging").pipe(Effect.as("resumed")));

  // TURN — per tick; branching is a ternary, reading is Ref.get
  return Effect.gen(function* () {
    return yield* AI.prose`
      This process manages issues for ${testAlchemy} from open to close.

      ${(yield* Ref.get(phase)) === "awaiting"
        ? AI.prose`Parked on the author. When their reply closes the gaps, ${resume}.`
        : AI.prose`
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

Refs are **ephemeral by doctrine**: if the run must survive passivation,
derive the state from the world (level-triggering) or wait for the durable
kernel's opt-in named-state variant. Don't tax every charter with naming.

## 4. `AI.Thread` and `AI.Tick` — kernel facts + affordances

Two run-scoped `Context.Service`s, provided by the kernel to init, turn, and
tool handlers. `AI.Thread` is the RUN — identity and conversation;
`AI.Tick` is the current sampling iteration:

```ts
interface ThreadService {
  readonly key: string;                             // world identity (`o/r#7`) or minted
  readonly tokens: Effect<number>;                  // ESTIMATED thread size
  readonly entries: Effect<ReadonlyArray<Message>>; // READ-ONLY thread access
  /** Request compaction — applied by the kernel at the next sampling
   *  boundary, never mid-assembly. Recorded; never silent. */
  readonly compact: (plan: CompactPlan) => Effect<void>;
}

interface TickService {
  readonly count: number;                           // samplings so far, this run
  readonly say: (note: Fragment) => Effect<void>;   // the collector behind AI.say
}

type CompactPlan =
  | { drop: (entry: Message, index: number) => boolean }  // → archived marker
  | { reset: { summary: string } };                       // fresh thread: head + summary
```

The thread stays kernel-owned: `entries` is read-only and `compact` is the
one, boundary-applied mutation. That asymmetry is the design.

## 4b. The four channels

Everything that reaches the model travels one of four channels with
distinct truth semantics:

| channel | semantics | authored by | delivery |
|---|---|---|---|
| **head** | constitution, frozen | first tick's stance | system prompt, byte-stable |
| **situation** | standing state — supersedes, restores | kernel, derived from stance diffs | on change only, `<situation>` |
| **note** | events — happen once, never revoked | charter, `yield* AI.say` | on first appearance per thread, `<note>` |
| **steer** | the world's voice | Layer / tools / humans | immediately, as inputs |

`AI.say` is DECLARATIVE with event semantics — the kernel *collects* says
during turn evaluation and dedupes by rendered text against the thread's
delivered log, so the turn stays re-entrant (a re-run collects the same
text and delivers nothing), a changed text is a new event, and nothing is
ever revoked or restated:

```ts
return Effect.gen(function* () {
  const n = yield* Ref.get(attempts);
  if (n > 0) yield* AI.say`Attempt ${n} of 5 — a failed run parks, never retries blind.`;
  return yield* AI.prose`…stance…`;
});
// tick 2 (n=1):  <note>Attempt 1 of 5 …</note>   delivered once
// tick 3 (n=1):  (same text → silent)
// tick 4 (n=2):  <note>Attempt 2 of 5 …</note>   changed text = new event
```

Rules: notes **grant nothing** (a `${Tool}` in a say renders as a name; the
toolkit comes from the stance alone — capability must never be a function
of the delivered log); per tick, the situation lands first, then notes in
emission order; **delivery logs are thread-scoped** — a compaction `reset`
clears them, so the standing situation restates itself and still-true notes
re-deliver into the fresh thread, while stale ones stay gone.

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
unchanged stance, which the kernel re-parks without sampling.

## 6. Exit, goals, budgets — patterns, not primitives

```ts
const EngineerCharter = Effect.gen(function* () {
  // init: setup only — bindings for tools, Refs. The run (AI.Thread /
  // AI.Tick) is a RUNTIME fact, visible only to turns and handlers.
  const open = yield* OpenPullRequest;
  const opened = yield* Ref.make<Pr | undefined>(undefined);
  const openPullRequest = yield* AI.Tool("open_pull_request")`
    Open the pull request citing ${issue}.`((params) =>
    open(params).pipe(Effect.tap((pr) => Ref.set(opened, pr))));

  return Effect.gen(function* () {
    const pr = yield* Ref.get(opened);
    if (pr) return pr; // ACHIEVE: exit = a return value
    const { key } = yield* AI.Thread;
    const { count } = yield* AI.Tick;
    if (count > 40) {  // BUDGET: a fact + a typed error
      return yield* Effect.fail(new AI.Refused({
        loop: key, reason: "no green PR after 40 samplings",
      }));
    }
    return yield* AI.prose`
      You receive exactly one ${issue}. ${Coding} is your craft; when
      green, ${openPullRequest} citing the issue. You do not review or
      merge.`;
  });
});
```

- **achieve** = `if (done) return value` — success is observed (a ref the
  tool wrote, a cached world read), never the model's claim.
- **maintain** = a turn that never returns a non-Fragment (perpetual).
- **refuse** = `Effect.fail(new AI.Refused(...))` — the evidence bar
  (repeat-observed blocker) is a counter ref, userland.
- A settled-from-inside run resolves its `dispatch` waiters with the
  returned value; the world can still `settle` first — it outranks.

## 7. Compaction: kernel mechanism, userland policy

The kernel guarantees three things regardless of who triggers it: applied
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

The frozen head is never touched by compaction; `reset` restarts the thread
as head + summary-as-situation, and — because delivery logs are
thread-scoped (§4b) — the standing situation and still-true notes restate
themselves into the fresh thread on the next tick. Derivation-shaped
processes (e.g. Distilled) can reset at every park — the Reactor
configuration.

## 8. Components: init → turn, fractally

A component is the charter shape at smaller scale. Three levels:

```ts
// 1. prose function — stateless vocabulary
const dedupePolicy = (repo: Repository) => AI.prose`
  Check prior art with ${SearchIssues}. Duplicates: ${LinkIssues} to the
  original, ${Comment} the author, ${CloseIssue}.`;

// 2. dynamic fragment — an Effect splice, re-evaluated every render
const ciBanner = (ci: Ref.Ref<CiState>) => Effect.gen(function* () {
  const s = yield* Ref.get(ci);
  return s.red
    ? AI.prose`CI is RED (${s.reason}). Restoring it outranks everything below.`
    : AI.prose``;
});

// 3. stateful component — own refs + tools; init'd in init, spliced in the turn
const workingNotes = Effect.gen(function* () {
  const notes = yield* Ref.make("");
  const remember = yield* AI.Tool("remember")`
    Replace your working notes — decisions, open threads, blockers.`(
    (p: { text: string }) => Ref.set(notes, p.text).pipe(Effect.as("noted")));
  return Effect.gen(function* () {
    return yield* AI.prose`
      ## Working notes
      ${(yield* Ref.get(notes)) || "(none yet)"}
      Keep these current with ${remember}.`;
  });
});

// host
const charter = Effect.gen(function* () {
  const notes = yield* workingNotes;              // component INIT
  return Effect.gen(function* () {
    return yield* AI.prose`
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
AI.prose`A ready issue is handed to ${Engineer}, whose PR must cite it.`;

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
AI.prose`
  For broad file surveys, spawn workers with only ${Grep} and ${ReadFile} —
  one question each, never the whole task.`;
```

Component vs subagent vs skill: component = same thread, an *aspect* of one
conversation; subagent = fresh window, isolation, parallelism; skill = a
component the model opts into (dormant, activation returns its prose as a
tool result — cache-safe).

## 10. Layers, composition, testing

Requirements propagate through R and are discharged at composition:

```ts
// the desk's Shape is a plain Context.Service; the agent behind it is
// PRIVATE (un-exported), with its own default Layer
class IssuesAgent extends AI.Agent<IssuesAgent>()("Issues") {}
const IssuesAgentLive = IssuesAgent.make(charter);   // R: Engineer | Kernel | ...

export const IssuesLive = Layer.effect(Issues, Effect.gen(function* () {
  const issuesAgent = yield* IssuesAgent;            // the loop, private
  yield* GitHub.consumeRepositoryEvents(testAlchemy, { events: [...] }, route(issuesAgent));
  return { list: ... };
})).pipe(Layer.provide(IssuesAgentLive));

const Org = IssuesLive.pipe(
  Layer.provide(Engineer.make(EngineerCharter)),     // or a DevBox-backed variant
  Layer.provide(KernelMemory),
  Layer.provide(MemoryLedger),
);

// tests: fake a whole agent with one Layer — no kernel, no model
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

## 11. Kernel behaviors (invisible to charters)

- **Per-run init**: the charter runs on first admission of a key; its
  closure is the run's instance. Distinct keys = distinct instances.
- **Channel delivery order**: per tick, situation first, then notes in
  emission order; all kernel-authored messages are user-role but
  delimited (`<situation>`/`<note>`), with both contracts taught once in
  the head's coda. Delivery logs are thread-scoped (§4b).
- **Head freeze + situations**: the first tick's document freezes as the
  system prompt (byte-stable; prompt-cache discipline). Later ticks are
  set-diffed; changed non-head blocks arrive as one `<situation>` message
  (full restatement, latest supersedes). Returning to the head state is
  announced ("the prior situation no longer holds") — restoration is a
  transition too.
- **$0 no-op tick**: an unchanged stance with an empty inbox re-parks
  without sampling (matters once resync/reminder wakes exist).
- **Steer to an unknown key admits** (crash-recovery: a re-polled event
  must never be silently dropped).
- **Sampling and turn failures retry** with capped backoff before failing
  the run (transient provider errors never poison a key). Full supervision
  (quarantine, escalation, intensity) is an interpret option — deferred.
- **Quiescence parks; the world settles.** Unchanged.

## 12. Per-tick configuration (model, sampling params)

Everything that configures the *sampling itself* — model tier, temperature,
`tool_choice` forcing — is per-tick state, so it lives where per-tick state
lives: the turn's return, as pipeable Fragment annotations (the one
extension mechanism, per [notes-effect-native](./research/notes-effect-native.md)):

```ts
return yield* AI.prose`
  Survey the failures across all 40 files and group them.
`.pipe(AI.model("fast"));            // cheap tier for bulk work

return yield* AI.prose`
  Decide: merge or request changes. Cite the diff.
`.pipe(AI.model("default"));         // judgment gets the big model
```

- Tier names are resolved by a `Models` SERVICE the kernel requires (the
  same seam pattern as `LanguageModel`/`Sandbox` — never kernel
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
  registry. The mechanism (Fragment metadata the kernel may read) is
  already load-bearing elsewhere.

## 13. Deferred (designed, not yet implemented)

- Kernel options: supervision (`restart`/`intensity`/`onGiveUp`), resync
  schedules, lanes + sampling token bucket, per-tool cooldowns, self-event
  filtering.
- KernelDurable: snapshot-at-park, passivation, reminders (time as a wake
  source that survives eviction), named-state variant of `Ref`.
- Union-toolkit + stance masking (cache-stable wire representation of
  mention-is-presence): unmentioned tools stay in the provider payload
  (tool-block cache intact) and are rejected on call with a
  model-visible "not in your current stance". A transport decision —
  the SEMANTICS stay §2b's mention-is-presence, unchanged.
- **Codemode as a kernel wire-mode** (`KernelCodemode`): one byte-stable
  `execute` tool; the tick's grants become a generated, typed API inside a
  sandbox, bridged to the same handlers — mention-is-presence unchanged as
  the semantics, the wire goes cache-stable, loops compose in code, and
  intermediate results stay out of the thread. The sandbox is a **service,
  not a kernel property** — the same seam pattern as `LanguageModel` and
  the Ledger:

  ```ts
  export class Sandbox extends Context.Service<Sandbox, {
    /** Execute code against a set of bridged capabilities. The bridge is
     *  the enforcement point: only this tick's granted handlers exist,
     *  and guards/budgets/cooldowns meter every bridged call. */
    readonly execute: (options: {
      readonly code: string;
      readonly bindings: Record<string, (input: unknown) => Effect.Effect<unknown>>;
      readonly timeout?: Duration.DurationInput;
    }) => Effect.Effect<SandboxResult, SandboxError>;
  }>()("alchemy/AI/Sandbox") {}

  // KernelCodemode: Layer<Kernel, never, LanguageModel | Sandbox>
  KernelCodemode.pipe(Layer.provide(SandboxBun));      // local subprocess
  KernelCodemode.pipe(Layer.provide(SandboxWorkerd));  // DO kernel: native isolates
  KernelCodemode.pipe(Layer.provide(SandboxFake));     // tests: scripted execution
  ```

  Exposing the thread and a cheap sub-model through the same bridge
  (`thread.grep(...)`, `llm(...)`) IS the RLM configuration — and because
  `Sandbox` is an ordinary service, userland can reach the same seam (an
  opt-in `eval` tool in a charter resolves `Sandbox` from context like any
  other capability). Mode chosen per term at Layer composition; switch at
  run start or compaction boundaries, not per tick.
- `spawn` context grants (pass-by-reference thread spans) + model tier.
- `AI.model`/sampling-param annotations + multi-model kernel registry (§12).
- Whole-program head vs frozen-first-branch (empirical; needs a benchmark).
