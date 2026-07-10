# Perpetual vs goal processes — the two species and their composition algebra

A design-research report answering: **what is the precise difference between a
perpetual process and a goal-oriented process, how do they compose, and does
the composition preserve the composable-natural-language DX?** Motivating
concerns (owner): the org example's `Channel` — a perpetual-ish thing — was
given a goal-type exit; maybe channels should be deterministic APIs that
*trigger* goal processes; maybe too much relies on LLM decisions.

Method: `designs/ai/reports/agent-loop-algebra.md` (the algebra), the main
design (§1, §2.5, §2.8, §2.9), `src/AI/{Process,Halt,Trigger,EventSource,
EventBus,Observe,Fold,KernelMemory}.ts`, `src/AI/Api/{ChatSessions,Chunks}.ts`,
`examples/agent-chat-web/src/{org,server}.ts`, `designs/ai/org-chat.md`, and
the sibling report `reassess-deterministic-orchestration.md`. Claims about
existing code cite `file:line`.

---

## 0. Verdict up front

**The two species are real, but they are not two kinds of term — they are the
two halves of a factorization the algebra already contains.** Perpetuity
belongs to the *serving* (the ring); goals belong to the *run*:

```
serve : Triggers<In> × Goal<In, Out, Err> → Server<Err>
        Stream<In>   × (In → Run<Out,Err>) → Run<never, Err>
```

Every served process **already is** a perpetual server of goal runs. The
`never` of the ring is a theorem (the trigger stream is unbounded), derived
by `serve` — never authored. `AI.never` (run-level `Out = never`) is a
*different* `never`: the degenerate case where the per-item work has no run
structure at all — and degenerating it erases the entire elimination surface
of the algebra (§1.2 below).

**Answers to the three motivating concerns:**

1. **The Channel's goal-type exit was correct, not a mistake.** What the
   original §2 sketch (org-chat.md, `AI.never`) mis-assigned is *which entity
   is perpetual*: the channel-as-server is the ring (deterministic, derived
   from `${AI.on(ChannelMessage)}`); the Post is a job (a run with a
   resolution). This was falsified empirically, not just theoretically: with
   only per-iteration terminals, a channel run's serving window hung forever —
   `run.settled` exists because the org channel forced it
   (`KernelMemory.ts:648-655`, `Api/Chunks.ts:198-233`).
2. **"Channels as deterministic APIs that trigger goal processes" is already
   what a channel is**, structurally: `serve(AI.on(ChannelMessage), postGoal)`.
   The remaining question — whether the *per-Post coordinator* is prose or
   code — is the §2.9 determinism-line question, answered in
   `reassess-deterministic-orchestration.md`: coordination is code by default,
   prose coordinators for open-ended rooms, fuzzy judgment as leaves either
   way. The two answers compose because both sides are just tags resolving to
   `ProcessService`.
3. **A perpetual process should (almost) never be an LLM loop itself — and in
   the implementation, it already isn't.** The memory kernel's `AI.never` arm
   serves each work item as ONE kernel-default turn with `seed: []` — no
   carried transcript, no standing LLM state (`KernelMemory.ts:896-931`).
   Everything actually perpetual (the mailbox, the trigger streams, the serial
   loop, single-writer discipline) is deterministic kernel machinery
   (`KernelMemory.ts:180-188, 735-750`). The feared "LLM loop that never
   ends" exists only in the vocabulary. The code already made the right
   choice; the design language should catch up.

**Recommended doctrine, in one line:** *servers are topology, jobs are work* —
perpetual things route, remember, and spawn; goal things think, get judged,
and end. Natural language composes **per-run** (goal charters, classifier
leaves, health prose); perpetuity composes **per-Layer** (triggers, serve,
event wiring).

---

## 1. The two species, formalized

### 1.1 Definitions in the existing algebra

Fix the algebra's one object (`agent-loop-algebra.md` §1.3):

```
Run<Out, Err>        ≅ Channel<KernelEvent, Err, Out, Steer>
Process<In,Out,Err>  =  In → Run<Out, Err>
```

Define the species as constraints on `Out`:

```
Goal<In, Out, Err>   := In → Run<Out, Err>      where Out ≠ never   -- a JOB
Server<Err>          := Run<never, Err>                              -- a DAEMON
```

- A **goal process** is a genuine Kleisli arrow: `Run<_, Err>` is a monad in
  `Out`, so goal arrows compose (`>=>`), fan out (`Effect.all`), and join.
  Its run ends by exit — model-declared resolve (halt-as-tool,
  `KernelMemory.ts:986-1008`) graded by a check, a `MachineCheck` oracle, or
  a human verdict via Ask — and is bounded by budget grading. Its typed
  abnormal exits are `Refused` (ratified give-up) and `BudgetExceeded`
  (`Process.ts:102-113`). Examples: `Fix`, resolve-this-Post, review-this-PR.
- A **perpetual server** has `Out = never`. In Channel terms this is exact:
  with `OutDone` uninhabited, `Channel<E, Err, never, Steer>` degenerates to
  the product of its one-sided views — a `Stream<KernelEvent, Err>` (the
  covariant face) and a `Sink<Steer>` (the contravariant face). Effect v4
  already names this: streams and sinks are the one-sided degenerations of
  Channel. **The goal species is the total Channel; the perpetual species is
  its stream/sink degeneration.**

### 1.2 What `Out = never` erases (the elimination audit)

Every operator the org needs eliminates on `Out` or routes around it. Setting
`Out = never` uninhabits, one by one:

| Elimination | Goal (`Out ≠ never`) | Perpetual (`Out = never`) |
|---|---|---|
| `dispatch` (Effect view) | `Effect<Out, Err>` — awaitable | `Effect<never>` — uncallable by construction (`Process.ts:63-73`) |
| Kleisli composition | `f >=> g` — pipelines | vacuous (`flatMap` on `never`) |
| fan-out / join | `Effect.all` + barrier | meaningless — nothing settles |
| spawn + completion-steer | child's `Out` becomes parent's steer (§2.8) | no completion event exists |
| check | grades the resolution claim | **no claim to grade** |
| `Refused` | typed give-up | nothing to give up on — already excluded from `Err` (`Process.ts:111-113`) |
| budget | bounds the run | ambiguous: bounding the *server* is an outage, not a result |
| `run.settled` | the uniform durable terminal; serving windows close on it | never emitted — the window-hang bug (`KernelMemory.ts:648-655`) |
| steer | ✓ (boundary injection) | ✓ |
| observe | ✓ (covariant projection) | ✓ |
| interrupt | ✓ (Scope authority) | ✓ |

Only the three operations that never touched `Out` survive. **A perpetual run
is compositionally inert: it can be watched, nudged, and killed — never
awaited, judged, composed, or joined.** This is the formal content of "a
perpetual thing is connective tissue, not a worker."

### 1.3 The factorization theorem

`serve(t, g) : Run<never, Err>` exists *for every goal process* — a perpetual
server is a derived object, obtained by lifting a goal arrow over its trigger
stream (`agent-loop-algebra.md` §1.3 elimination 3; implemented as the
mailbox drain at `KernelMemory.ts:735-750`). So the design question "is this
term perpetual or goal-oriented?" decomposes into two independent questions
with different owners:

1. **Does it serve triggers forever?** — Yes for anything with `AI.on`/
   `AI.each`/`AI.every`. This is the *ring*, it is deterministic kernel
   machinery, and it is perpetual **whether or not** the term says
   `AI.never`. Nobody authors this perpetuity; `serve` derives it.
2. **Does the per-item work have run structure?** — i.e. an exit to declare,
   a claim to grade, a budget to bound, a result someone consumes. If yes:
   `AI.until` (goal). If the item is a conversation message whose reply *is*
   the deliverable and the human is the check: the kernel-default single turn
   (Agent semantics). `AI.never` on a Process is exactly the second shape
   wearing process clothes — the memory kernel implements it as "agent
   semantics per item" verbatim (`KernelMemory.ts:896-898`).

The three legitimate combinations, in one table:

| ring (always deterministic) | per-item run | who is this |
|---|---|---|
| `serve(triggers, ·)` | goal run (`AI.until` + check/fold/budget) | **the Channel as built** — Post → resolution (`org.ts:44-69`); Fix; any job server |
| `serve(triggers/mailbox, ·)` | one kernel-default turn (`AI.never` / Agent) | conversation surfaces: DMs, a notifier — human is the check |
| `serve(triggers, ·)` | code handler (no model) | the deterministic channel/router (`reassess-deterministic-orchestration.md` §4, proposed `AI.process(term, handler)`) |

There is no fourth row. "An LLM loop with no exit and standing transcript" is
not a species — it is the pathology every surveyed system warns about (Eve's
conversation-mode leak; unbounded context; ungradable, unbudgetable,
unjoinable) and the current kernel deliberately does not implement it.

### 1.4 Is a perpetual process EVER an LLM loop itself?

Argued from three directions, all landing on the same answer:

**From the determinism line (§2.9).** A perpetual server's decisions are all
*occurrence* decisions: should this event start work? does this message
address an open thread or open a new one? who is wired to handle it? Doctrine:
occurrence is deterministic; judgment is fuzzy and lives in leaves. A standing
LLM coordinator puts fuzzy machinery in a deterministic role — the precise
inversion §2.9 forbids. The fuzzy parts a room genuinely needs ("is this deep
or quick?") are classifier *leaves invoked by the deterministic side*, or
prose *inside the spawned goal run* — never the loop that decides whether
loops happen.

**From the type algebra (§1.2).** Whatever intelligence a perpetual LLM loop
produced would be unreachable: no `Out`, no join, no verdict. Its only output
channels are Trace events and world side effects — and if world side effects
are the product, the producer of each side effect can and should be a bounded,
budgeted, judged goal run rather than an unaccountable standing burn.

**From standing state.** The seductive argument for a perpetual LLM loop is
memory — "the channel remembers the room." But the kernel already refuses
this: the `AI.never` arm seeds every turn empty (`KernelMemory.ts:920-923`),
and even the *conversational agent's* continuity is implemented outside the
ring — the serving tier materializes the transcript and rides it in on the
work item (`conversationItem`, `Api/ChatSessions.ts:69-95`), because "the
kernel is session-free — a run's world state rides in its work item." Standing
memory has exactly three legitimate homes, none of which is an endless
transcript:

1. **The world** — repo artifacts, the message log, a DB (Ralph semantics:
   `Fold.ts:20-22`).
2. **Per-world-identity folds** — a thread is a run; its carried fold is its
   memory, scoped and compressible (org-chat R2/R3).
3. **Materialized views in the serving tier** — ChatSessions transcripts,
   channel timelines: projections of Trace facts, rebuildable.

**When a per-item LLM turn under `AI.never` IS right:** the conversation
shape — the item is a message, the reply is the deliverable, the human reading
it is the check, and no machine consumes the output. That is precisely the
Agent kernel-default specialization; `AI.never` on a Process buys Agent
semantics plus triggers plus declared health prose (`Halt.ts:20-23`,
`kernelPrompts.perpetualNote`). Legitimate, narrow. The moment per-item work
grows a second turn, tool use worth verifying, or a consumer that awaits a
result — it is a goal run, and the term should say `AI.until`.

Litmus tests, in order of decisiveness:

- **Does anything await the output?** Anything ⇒ goal. Nothing but human
  eyeballs ⇒ conversation shape is admissible.
- **Can it meaningfully fail?** If `Refused`/`BudgetExceeded` are sensible
  outcomes ⇒ goal (a server "refusing" is an outage, not a result).
- **Would you ever want a check?** A claim worth grading ⇒ goal (a check on
  `AI.never` has nothing to grade — see the lint proposal, §4).

---

## 2. The composition algebra

The complete operator set the org needs, each with a precise signature over
the two species. `G = Goal<In,Out,Err>`, `S = Server<Err>`, `t : Triggers<In>
= Stream<In>`.

**1. trigger-spawn** — the constructor of every perpetual thing:

```
serve : Triggers<In> → Goal<In,Out,Err> → Server<Err>
serve(t, g) = t.concatMap(g)        -- Concurrency = the merge policy
```

Laws: module action over the trigger monoid (`serve(t₁ ⊕ t₂, g) =
serve(t₁,g) ⊕ serve(t₂,g)`); each spawned run's world identity rides in `In`
(thread id, issue ref). Implemented: the mailbox drain
(`KernelMemory.ts:735-750`), triggers subscribed at interpretation
(`KernelMemory.ts:843-894`, `Trigger.ts`, `EventBus.ts`). *This is the whole
"channels are deterministic APIs that trigger goal processes" proposal,
already in the kernel.*

**2. call (sync)** — Kleisli elimination:

```
dispatch : Goal<In,Out,Err> → (In → Effect<Out,Err>)        -- admit + join
(f >=> g)(a) = f(a).flatMap(g)                              -- events concat, Out threads
```

Landed as the delegation tool (§2.8 pattern 1, `KernelMemory.ts:1446-1519`).

**3. fan-out / join** — no term, by standing decision (§2.8 pattern 2):

```
fanout : Goal<In,Out,Err> → (In[], Concurrency) → Effect<Out[], Err>
       = Effect.forEach(items, g.dispatch, { concurrency })
```

Host-language concurrency; the barrier is the join. Requires `Out ≠ never` on
every branch — you cannot fan out over servers.

**4. spawn-and-continue (async)** — the done-value-to-steer wiring:

```
spawn    : Goal<In,Out,Err> → In → Effect<RunKey>            -- send + registry
onSettle : (RunKey, Out|Err) → Steer(parent)                 -- completion-steer
check    : RunKey → Effect<Status>                           -- pure Trace read (check_runs)
wait     : RunKey → Effect<Out, Err>                         -- Ask-protocol park (wait_run)
```

Formally: connect the child channel's `OutDone` to the parent channel's
`InElem` — the one operator that crosses the covariant/contravariant boundary,
which is why it must route through the kernel (a durable steer), never a
private pipe. Landed: `background: true` delegation + completion steers +
`check_runs` + `wait_run` (`KernelMemory.ts:1424-1636`, design §2.8b-c).

**5. steer** — contravariant injection into a *running goal*:

```
steer : RunKey → Msg → Effect<void>       -- delivered at the iteration boundary
```

Works on both species (a server's per-item turn has a boundary too), but its
*addressing* needs the run key — the org's threads-as-runs makes Phase-2
run-key steering load-bearing (org-chat R2; `Process.ts:32-36`).

**6. observe** — the covariant projection, `Req`-free by variance:

```
observe : Run<Out,Err> → Stream<KernelEvent>                  -- read without waking
```

`AI.observe(term)` grants trace access and none of the subject's capabilities
(`Observe.ts:8-18`). This is the *only* correct standing relationship between
two servers' internals — reading, never reaching.

**7. escalate** — two rungs, one per direction:

```
ask : Payload → (run parks until correlated Answer)           -- goal → human (Ask)
err : Run<Out, Err> fails typed → parent's Effect.catchTag    -- goal → parent code
```

Both are *goal-run* operations: a park needs a run to park, a typed failure
needs an `Err` channel someone awaits. A server escalates only by spawning a
goal run that escalates — another face of §1.2's inertness.

**8. standing collaboration** — two servers, through the world only:

```
emits : Server → EventSource*            -- tool side effects publish world events
S₁ ∥ S₂ = serve(t₁ ⊕ emits(S₂), g₁)  merged-with  serve(t₂ ⊕ emits(S₁), g₂)
```

The §2.5 constitution: sideways only through the world, never a private
cross-ring channel. Note what the shape guarantees: each "exchange" between
standing peers is *mediated by a goal run at each end* — Support's run files
an issue (bounded, judged), the event wakes Flywheel, Flywheel spawns a run
(bounded, judged). Two perpetual LLM coordinators exchanging prose directly
would be an ungradable ping-pong with no join and no verdicts; the
through-the-world rule plus goal runs at each end keeps every LLM burst
bounded and accountable.

**9. fold (standing memory)** — the algebra position, not a communication op:

```
fold : (Carried, TraceSegment) → Carried      -- run-scoped; THE unit of memory
```

Included because it is where "the server remembers" must land: per-run
(thread) folds and world artifacts — never a cross-run transcript (§1.4).

**The typing observation that summarizes the whole table:** operators 2, 3, 4,
and 7 *eliminate a goal's `Out`*; operator 1 *consumes a goal* and is the only
producer of perpetual things; operators 5, 6 apply to anything; operator 8
relates servers only through events that spawn goals. **No operator eliminates
a perpetual run** — servers appear only as `serve`'s output and as endpoints
of event routing. Servers are topology; jobs are work.

---

## 3. Composable natural language across the split

The owner's constraint: keep "composable natural language" while separating
the species. The split not only preserves the prose DX — it *relocates each
kind of prose to the layer where it composes best*.

### 3.1 Prose composes at seams both species share

The composition operators of §2 are all *prose-visible* today: `${Sage}`
(call), the `background` param (spawn), `steer_run` (steer, org-chat item 2),
`${AI.observe(X)}` (observe), `${AskHuman}` (escalate), `${AI.on(Event)}`
(trigger-spawn). Because the unit of composition is the **tag** (every term
resolves to `ProcessService`), a code-implemented server and a prose goal
process interpolate into each other's worlds identically — a prose charter can
say `${Engineering}` whether Engineering is a charter or a `Layer.effect`
hand-implementation, and deterministic code calls `sage.dispatch(post)`
whether Sage is prose or code. Nothing about the species split fragments the
template language.

### 3.2 Where the perpetual coordinator's prose actually goes

Dissect the as-built Channel kind's charter (`org.ts:44-69`) and every
sentence lands in one of four homes — none of which is a standing coordinator:

| Prose in today's Channel scaffold | Its real home |
|---|---|
| "For each Post: decide which member(s)…" (routing) | a **classifier leaf** (one `generateObject` call invoked by code, with a typed fallback) or the goal run's opening judgment |
| "relay their final response with `${PostReply}`" (mechanics) | **code** — the failure mode the prose legislates against ("you NEVER write prose into the thread") cannot exist in code |
| "Resolve the moment the Post needs nothing more" + `AI.until(S.String)` | the **goal charter** — halt prose, the give-up evidence bar, the resolution contract: this is where NL is irreplaceable |
| membership & room character ("Sage for depth, Scout for speed") | the **instance splice** (`spliceCharter`, `Process.ts:234-275`) — lands in the per-run goal charter via the kind scaffold |

So the recomposed Channel kind — prose variant and code variant alike — has
one shape:

```
Channel (a kind, userland)
├─ ring     : serve(AI.on(ChannelMessage), PostGoal)   ← perpetual, deterministic, DERIVED
├─ per-Post : goal charter — AI.until(S.String), budget, check;
│             instance prose splices HERE                ← where composable NL lives
└─ leaves   : routing classifier, member agents          ← fuzzy judgment, positionally invoked
```

The as-built `org.ts` is already the prose variant of this shape — the
`AI.until` + `AI.budget` scaffold *is* the per-Post goal, and the ring is the
perpetual part the kernel derived. What v1 got right by accident, this report
makes doctrine. The code variant (`AI.process(term, handler)`,
`reassess-deterministic-orchestration.md` §4-5) swaps the goal-run coordinator
for a handler and keeps everything else — same tag, same triggers, same
topology, same timelines.

### 3.3 The R4 message-semantics rule, settled by the split

"Is a new message a trigger or a steer?" (org-chat R4) is an *occurrence*
decision and therefore deterministic by doctrine: **message carries an open
thread's run key ⇒ steer that run; otherwise ⇒ new run** — kernel-exact, no
model call. The fuzzy residue ("does this un-threaded message *address* the
open discussion?") is an optional classifier leaf the deterministic rule may
consult — a leaf with a typed fallback (default: new run), never a standing
coordinator deciding whether occurrence occurs. Same shape as the check slot's
graduated verification (§2.9): deterministic occurrence → cheap fuzzy gate →
expensive judgment.

### 3.4 What NL is *for*, per species — the one-sentence versions

- **Goal prose** is a *contract*: the mandate, the halt condition, the
  evidence bar, the delegation vocabulary. It composes by interpolation and
  the kind splice, and the machinery (check, fold, budget, Ask) holds the run
  to it. This is where the composable-NL bet pays.
- **Server prose** is *metadata*: health signals (`AI.never`'s template —
  documentation of what substitutes for an exit), routing hints (better as
  classifier prompts), room character (better spliced into the goal charter).
  None of it needs a standing model to read it on every event.

---

## 4. Recommendations

1. **Adopt the vocabulary: server vs job, and "perpetuity is derived."**
   Stop describing `AI.never` terms as "perpetual processes" as if perpetuity
   were a property of the LLM loop; the ring is perpetual for every served
   term, and `AI.never` only declares that the per-item run is a single
   default turn. Docs touchpoints: `Process.ts` (the `ProcessOut` comment),
   `Halt.ts`, design §1.2.1, org-chat §2.
2. **Keep `AI.never`, but scoped to the conversation shape** (item = message,
   reply = deliverable, human = check) and declared daemons whose per-item
   work is honestly single-turn. Anything with multi-step per-item work is
   `AI.until` — the run machinery (check, fold, budget, `run.settled`,
   join/steer/spawn) exists only under a run.
3. **New lints** (all pure, `AI.lint`-shaped):
   - `AI.never` + `AI.check` → **error**: a check grades resolution claims; a
     perpetual run never claims. (Same argument as the existing
     `until`+`never` contradiction.)
   - `AI.never` + `AI.fold` → **error** until per-item folds mean something:
     the fold is run-scoped and an `AI.never` run is one turn.
   - `AI.never` + `AI.budget` → **warning**: clarify per-item semantics (a
     budget that kills the *server* is an outage, not an exit).
   - `AI.never` + multiple tool refs / delegation refs → **info**: "multi-step
     work without a run has no boundary machinery — consider `AI.until`."
4. **Build the code-server half** — `AI.process(term, handler)` +
   `ProcessContext` + the prose-free term form, exactly as specified in
   `reassess-deterministic-orchestration.md` §5. This report supplies its
   missing theoretical justification: the handler *is* the deterministic
   router the perpetual species wants to be, and the goal runs it dispatches
   are where the prose stays.
5. **Keep the Channel kind goal-per-Post** (validated by v1) and restructure
   its scaffold along §3.2: mechanics out of prose (into the kind's code or
   tighter scaffold), judgment into leaves, contract prose into the per-run
   charter. Ship the org example with both variants side by side — the
   contrast is the tutorial.
6. **Settle R4 as doctrine** (§3.3): thread-key match is the deterministic
   default for steer-vs-trigger; the "addresses" classifier is an optional
   leaf with a typed fallback.
7. **Standing memory doctrine** (§1.4): world artifacts, per-world-identity
   folds, serving-tier materialized views. A ring MUST NOT accumulate an
   unbounded cross-run transcript; the kernel's `seed: []` is normative, not
   an accident of the memory implementation.

### What this deliberately does not propose

- **No new term kind.** `Server` is not a `~alchemy/Kind`; it is `serve`'s
  output. Reifying it would repeat the mistake the algebra report warned
  about (ring-vs-run is derived, not axiomatic).
- **No removal of `AI.never`.** The type-level story (`Out = never` makes
  `dispatch` uninhabitable "in exactly the right way") is correct and stays;
  only its role narrows.
- **No workflow DSL, no fan-out vocabulary** — standing decisions, reaffirmed
  by the elimination audit (§1.2): the operators are Effect combinators over
  `dispatch`, and they only typecheck against goals, which is the type system
  enforcing this report's thesis by itself.

---

## Appendix: citations for the load-bearing claims

| Claim | Citation |
|---|---|
| `serve` is the trigger-lift; ring-`never` is a theorem | `agent-loop-algebra.md` §1.3 (elim 3), §2.6; `KernelMemory.ts:735-750` |
| Two distinct `never`s (ring vs run) already kept apart | `agent-loop-algebra.md` §2.6; `Process.ts:63-73` doc comment |
| `AI.never` = one kernel-default turn per item, `seed: []`, ring never resolves | `KernelMemory.ts:896-931` |
| Agent runs are also seeded empty; conversation continuity lives in the work item | `KernelMemory.ts:806-814`; `Api/ChatSessions.ts:69-95` |
| Perpetual runs excluded from `Refused` by type | `Process.ts:102-113` |
| `run.settled` forced by the org channel's window hang | `KernelMemory.ts:648-655`; `Api/Chunks.ts:198-233` |
| Channel kind as built: goal exit per Post, budget 8 | `examples/agent-chat-web/src/org.ts:44-69` |
| Original sketch gave Channel `AI.never` | `designs/ai/org-chat.md` §2 (lines 72-89) |
| §2.8 patterns: call, fan-out, spawn+completion-steer, standing collaboration | `alchemy-ai-design.md` §2.8; `KernelMemory.ts:1424-1636` |
| Sideways only through the world; no private cross-ring channel | `alchemy-ai-design.md` §2.5 |
| Occurrence deterministic, judgment fuzzy; leaves inside always-invoked arrows | `alchemy-ai-design.md` §2.9 |
| Coordination is code by default; `AI.process(term, handler)` proposal | `reassess-deterministic-orchestration.md` §4-5 |
| Observation grants trace access, no capabilities | `Observe.ts:8-18` |
| Fold is the unit of memory and durability; Ralph semantics | `Fold.ts:9-22` |
| Kind splice: instance prose lands in the scaffold | `Process.ts:234-275`; `org-chat.md` §2.5 |
| Health prose on `AI.never` | `Halt.ts:20-23, 66-69`; `KernelPrompts.ts:48-50` |
