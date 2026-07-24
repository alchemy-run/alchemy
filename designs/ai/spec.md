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
| `Fragment` | the render IS the system prompt, verbatim → build toolkit → sample |
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
  The stance TEXT is the source of truth and the render IS the system
  prompt, so a toolkit change always arrives with its explanation.
  Concretely, the Issues desk's turn renders its phase:

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
the deferred **union-toolkit + stance masking** kernel option (§13):
unmentioned tools may stay in the provider payload and be rejected on
call — bytes change, the law does not.

### 2c. The wire seam: `WireMode` and codemode

Direct tool-calling loses what agents are best post-trained on: writing
CODE that composes primitives (Bash pipes are the canonical case). It
gains granular access control. Codemode keeps both: the model writes a
program; the ONLY functions in scope are this tick's granted handlers.

**`WireMode` is an optional service the kernel resolves from the
interpret context** at every sampling boundary. Absent: every grant is
its own provider tool (the default, unchanged). Present: the mode
transforms the tick's grants into their wire presentation. Semantics
never move — the stance still decides WHAT exists (mention-is-presence,
§2b); the mode decides how it APPEARS. Kernel intrinsics (`dispatch`,
`spawn`, `skill`) stay direct tools in every mode: they are
conversation control, not capabilities.

```ts
// swap the wire without touching a single charter:
IssuesLive.pipe(Layer.provide(AI.CodeModeEffect()))  // programs return Effects
IssuesLive.pipe(Layer.provide(AI.CodeModeAsync()))   // async/await + Promises
// provide neither: direct tool-calling
```

Both codemode Layers collapse the grants into ONE `eval` tool whose
description carries the mode's own TEACHING (how to write the code)
plus GENERATED SIGNATURES:

```ts
// from each grant's parameter schemas and its RETURN schema:
declare function readDiff(input: { pr: { owner: string; … } }): Effect<string>
```

The return type comes from the Tool's optional second argument —
`AI.Tool<ReadDiff>()("readDiff", S.String)` — undeclared means
`unknown`. Direct mode barely needs return schemas; codemode is why
they exist.

`CodeModeEffect` is the native flavor: the code is the body of a
function `(Effect, tools) => Effect<A>`, tools are Effect-returning,
and the whole program runs ON THE KERNEL'S FIBER — interruption,
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

Two run-scoped `Context.Service`s. `AI.Thread` is the RUN — identity and
conversation — provided to init, turns, and tool handlers alike: init runs
once per run at admit, when the thread already exists, so thread-scoped
setup (a checkout keyed by `thread.key`) belongs there. `AI.Tick` is the
current sampling iteration — no sampling is under way during init, so only
turns and tool handlers see it:

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

## 4b. The channels — every message traces to a call site

The design rule (learned the hard way — an earlier iteration DIFFED the
stance across ticks and injected the delta as kernel-authored
"situation" messages, which worked but made the context window emergent
rather than legible): **the kernel authors no messages of its own.**
The context window an agent author reasons about is exactly what they
can point to in code:

| channel | semantics | authored by | delivery |
|---|---|---|---|
| **system prompt** | the turn's render, verbatim | the charter's returned `Fragment` | whole, every sampling; byte-stable when the render is static |
| **note** | events — happen once, never revoked | charter, `yield* AI.say` | on first appearance per thread, `<note>` |
| **tool result** | the outcome of an action, incl. transitions the handler caused | tool handlers | with the call |
| **steer** | the world's voice | Layer / tools / humans | immediately, as inputs |

A CHANGED render simply replaces the system prompt (cache bust, on the
author's head) — no diff, no derived message. Keep the prompt static
and holistic (state every phase's rules; the conversation carries which
phase is live) and it behaves exactly as anyone would guess; a tool
handler that flips a phase announces the flip in its own RESULT.

`AI.say` is a PLAIN append — no dedupe, no memory, no kernel judgment.
Calling it is delivering it, so the author's condition IS the delivery
policy, exactly like any other side effect:

```ts
return Effect.gen(function* () {
  const { count } = yield* AI.Tick;
  if (count === 30) {
    yield* AI.say`30 of 40 samplings spent — converge now.`;
  }
  return yield* AI.prose`…stance…`;
});
// tick 30:  <note>30 of 40 samplings spent — converge now.</note>
// tick 31+: silent — the `===` guard already said it
```

An unguarded `say` delivers every tick — occasionally what you want,
usually a bug you can see at the call site. (One kernel courtesy: a
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
unchanged stance, which the kernel re-parks without sampling.

## 5b. Workspaces: the checkout as a capability

A coding agent needs a repository checked out somewhere it can work. That
"somewhere" is a capability like any other — one contract (`Git.Workspaces`),
physics chosen by the Layer:

```ts
// init: the binding, like any other capability
const workspaces = yield* Git.Workspaces;
const remote = GitHub.remote(testAlchemy);   // provider → Git, never the reverse

// init is per-run — the thread exists at admit, so the checkout is
// thread-scoped SETUP the turn and tools close over
const { key } = yield* AI.Thread;
const ws = yield* workspaces.checkout({ key, remote });

return Effect.gen(function* () {
  return yield* AI.prose`
    …your checkout lives at ${ws.path}; every file you touch lives under it…`;
});
```

The laws:

- **Idempotent by key.** `checkout` with the same key returns the same tree —
  acquired once in init, and a tool handler that derives the same key
  (`yield* AI.Thread` in the handler) lands in the exact tree the run
  works in. No workspace value is threaded through prose or params; the
  KEY is the address.
- **Isolated across keys.** Two concurrent runs get two trees. What crosses
  agent/machine boundaries is the pushed branch, never a shared filesystem.
- **Layer-swapped physics.** `Git.WorkspacesWorktree` (local): one central
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
  hands the model, so the tools can reach the run's tree but not escape.

## 6. Exit, goals, budgets — patterns, not primitives

```ts
const EngineerCharter = Effect.gen(function* () {
  // init: per-run setup — bindings, Refs, thread-scoped state
  // (AI.Thread is in scope; AI.Tick is turn-only)
  const { key } = yield* AI.Thread;
  const open = yield* OpenPullRequest;
  const opened = yield* Ref.make<Pr | undefined>(undefined);
  const openPullRequest = yield* AI.Tool("open_pull_request")`
    Open the pull request citing ${issue}.`((params) =>
    open(params).pipe(Effect.tap((pr) => Ref.set(opened, pr))));

  return Effect.gen(function* () {
    const pr = yield* Ref.get(opened);
    if (pr) return pr; // ACHIEVE: exit = a return value
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
- **Channel delivery order**: per tick, notes in emission order; notes
  are user-role but delimited (`<note>`), the one contract taught in
  the system prompt's constant coda. The say log is thread-scoped
  (§4b).
- **The render is the system prompt**: delivered whole at every
  sampling, no diffing, no kernel-authored messages. A static render is
  byte-stable (prompt-cache discipline); a changed render replaces the
  system prompt — legibility over cleverness, the cache cost is the
  author's choice.
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
- **Codemode: SHIPPED as `WireMode` Layers** (§2c) —
  `AI.CodeModeEffect()` / `AI.CodeModeAsync()` collapse the tick's
  grants into one `eval` tool with generated signatures; evaluation is
  v0 in-process. STILL DEFERRED: the sandbox-as-service extraction
  below (isolation + the RLM bridge). The sandbox is a **service,
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
