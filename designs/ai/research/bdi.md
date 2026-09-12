# BDI Agent Architectures and the Alchemy Charter Model

Research memo: Belief-Desire-Intention architectures and agent-oriented
programming (PRS, AgentSpeak(L)/Jason, GOAL, 2APL/3APL, and the deliberation
literature) as a lens on Alchemy AI's charter/stance/kernel design. One of nine
parallel paradigm studies.

## 1. The paradigm (precise semantics)

### 1.1 Bratman: intentions are commitments that resist reconsideration

Bratman's *Intention, Plans, and Practical Reason* (1987) is the philosophical
root. Its claims, in order of load-bearing-ness for us:

1. **Intentions are not reducible to belief + desire.** They are a third state:
   a *conduct-controlling* commitment to a partial plan. Desires are inputs to
   deliberation; intentions are its *outputs*, and once formed they are inputs
   to *future* deliberation.
2. **Intentions resist reconsideration — and this is a feature, not a bug.**
   Deliberation is expensive for a resource-bounded agent. An agent that
   re-deliberates at every step never acts (and pays constantly); an agent that
   never reconsiders pursues vanished goals. Intentions provide *stability*: by
   default you continue; only salient changes trigger re-deliberation.
3. **Plans are partial and hierarchical.** You intend the end and fill in means
   later ("means-end reasoning"), on demand.
4. **Intentions screen options** ("screen of admissibility"): options
   inconsistent with existing intentions aren't even generated.

Bratman, Israel & Pollack's IRMA (1988) turned this into an architecture whose
key component is a cheap **filtering/override mechanism** deciding which
environmental changes get to trigger re-deliberation at all — the ancestor of
every reconsideration policy since.

### 1.2 The abstract BDI interpreter (Rao & Georgeff 1995)

The canonical cycle, verbatim from the paper:

```
BDI-interpreter
  initialize-state();
  repeat
    options := option-generator(event-queue);
    selected-options := deliberate(options);
    update-intentions(selected-options);
    execute();
    get-new-external-events();
    drop-successful-attitudes();
    drop-impossible-attitudes();
  end repeat
```

The practical version (PRS/dMARS) makes three representation choices: beliefs
are ground literals about the *current* state only; options are **plans** — a
body of primitive actions/subgoals, indexed by an **invocation condition**
(triggering event) and a **precondition** (context); intentions are
**run-time stacks of hierarchically related plans** — "the interpreter does a
lazy generation of all possible sequences of actions that it can intend from
the plan library." Multiple intention stacks coexist: parallel, suspended on a
condition, or ordered. A `post-intention-status` hook at the end of the loop
controls which intention-structure changes the option generator gets to *see* —
that is how commitment strategies are implemented: commitment = information
hiding from your own deliberator.

Rao & Georgeff also name the commitment-strategy spectrum: **blind** (deny
belief changes that conflict with commitments), **single-minded** (drop when
believed impossible), **open-minded** (drop when beliefs *or* desires change).
Commitment always has two parts: the condition maintained, and the
**termination condition** under which it is given up.

### 1.3 PRS (Georgeff & Lansky 1987)

The first implementation: a belief database, a goal set, a **plan library of
Knowledge Areas** (partially elaborated procedures with invocation
conditions, both goal-driven and data-driven), and a process stack of active
KAs (= intentions). Two properties matter for us: plans are *only partly
elaborated before acting* (deliberate overcommitment avoidance), and PRS has
**meta-level KAs** — plans about its own beliefs/goals/intentions — so the
deliberation strategy is itself programmable. Kinny & Georgeff's experiments
(below) were literally implemented as PRS meta-level invocation criteria.

### 1.4 AgentSpeak(L) (Rao 1996) and Jason (Bordini & Hübner)

AgentSpeak(L) is the paradigm distilled to a computable language. A plan is

```
triggeringEvent : contextCondition <- body.
+!serve(Table) : available(waiter) <- !goto(Table); !take_order(Table).
```

The cycle: events (external: belief addition/deletion from perception;
internal: subgoal `!g` posted by a running plan) go on an event queue. For a
selected event, plans whose trigger unifies are **relevant**; those whose
context condition is a logical consequence of current beliefs are
**applicable**. Three selection functions — `S_E` (which event), `S_O` (which
applicable plan), `S_I` (which intention gets this cycle's step) — do all
deliberation. The chosen plan instance ("intended means") is pushed onto an
intention stack; subgoals in its body push further plans onto the *same* stack;
one agent interleaves many intention stacks over shared beliefs, one step at a
time.

**Failure handling (Jason):** when a plan body fails, the interpreter generates
a **goal-deletion event** `-!g` and looks *up the intention stack* for the
nearest goal that has a relevant failure plan; that plan runs, and when it
finishes the intention continues *as if the goal had succeeded* (contingency
handled, control resumes). With no applicable failure plan, the interpreter
either discards the whole intention or re-queues the event — a per-agent
configuration. `.fail_goal(G)` lets code raise the same event deliberately.
The idiomatic Jason retry is: failure plan re-posts the goal, and `S_O` now
picks a *different* applicable plan (the failed instance is spent) — automatic
alternative-recipe search over the plan library.

### 1.5 GOAL (Hindriks et al. 2000): declarative goals

GOAL's thesis: prior languages had only *goals-to-do* (procedures); rational
agency needs *goals-to-be* — **declarative descriptions of world states,
decoupled from any recipe**. A GOAL agent is (beliefs, goals) + condition-action
rules `if bel(φ), goal(ψ) then a`. The semantic payoff: a **commitment strategy
is built into the language** — the default is blind commitment, *a goal is
dropped if and only if the agent believes it achieved*, enforced by the
transition system, not the programmer. Because success is a predicate over
beliefs, failure detection, goal dropping, and re-planning become checkable
facts rather than programmer discipline. `adopt`/`drop` allow explicit
override. 3APL (Hindriks et al. 1999) contributes **plan-revision rules**
(rewrite a partially executed plan); 2APL (Dastani 2008) merges both: declarative
goals, plans, `PG-rules` (goal → plan), `PC-rules` (event → plan), and
`PR-rules` (plan repair).

### 1.6 Goal types and the goal life-cycle

The consensus taxonomy (Braubach et al. 2005 "Goal Representation for BDI Agent
Systems"; Dastani, van Riemsdijk & Meyer 2006 "Goal Types in Agent
Programming"):

- **perform** — do an activity; success = the activity ran (no world-state
  check). Fails only if no plan was applicable.
- **achieve** — reach a world state; the goal is dropped when the state is
  believed to hold (or believed unreachable). *The recipe failing is not the
  goal failing* — other plans are tried.
- **query/test** — know something (reducible to achieve/perform).
- **maintain** — keep a condition true, *forever*. **A maintain goal never
  completes.** Reactive form: when the condition is observed violated, adopt a
  recovery achieve-goal to restore it. Proactive form (Duff, Harland &
  Thangarajah 2006): *predict* violation and adopt a preventative goal before
  it happens.

Harland et al.'s operational goal life-cycle (2014) adds the states every
production system converged on: Pending, Active, **Suspended**, **Monitoring**
(a maintain goal between violations is Monitoring, not dead), plus
drop/abort/suspend/resume operations with defined semantics.

### 1.7 Intention reconsideration (Kinny & Georgeff 1991; Schut & Wooldridge)

The Tileworld experiments parameterized **boldness** (plan steps executed before
re-planning) against **rate of world change** γ and planning cost *p*. Results:
in slow worlds bold agents win (cautious ones pay deliberation tax for
nothing); in fast worlds cautious agents win (bold ones chase vanished holes
and miss opportunities). But the deepest result is the last one: an agent with
**rational commitment** — bold, but re-planning on cheap, targeted cues ("my
target disappeared", "a nearer hole appeared") — dominated *everywhere*,
beating both extremes. The optimal reconsideration policy is an **event filter,
not a frequency**. Schut & Wooldridge (2004) generalize: reconsideration is a
meta-level decision problem, and adaptive policies (learn when reconsidering
changed anything, adjust) approach the rational-commitment frontier.

## 2. Primary sources

What I actually read for this memo (fetched and read in full unless noted):

- Rao & Georgeff, *BDI Agents: From Theory to Practice*, ICMAS 1995 — read in
  full. <https://cdn.aaai.org/ICMAS/1995/ICMAS95-042.pdf>
- Kinny & Georgeff, *Commitment and Effectiveness of Situated Agents*, IJCAI
  1991 — read in full. <https://www.ijcai.org/Proceedings/91-1/Papers/014.pdf>
- Georgeff & Lansky, *Reactive Reasoning and Planning* (PRS), AAAI 1987 — read
  abstract + architecture sections.
  <https://web.eecs.utk.edu/~leparker/Courses/CS494-529-fall14/Homeworks/Papers/2.pdf>
- Rao, *AgentSpeak(L): BDI agents speak out in a logical computable language*,
  MAAMAW 1996 — semantics reconstructed from the paper's derived literature
  (Collier et al., *Reflecting on Agent Programming with AgentSpeak(L)*, PRIMA
  2015, read in full) plus prior knowledge. <https://doi.org/10.1007/BFb0031845>
- Jason failure handling: Bordini/Hübner course material (Nebel et al. slides on
  *Programming Multi-Agent Systems in AgentSpeak using Jason*, Wiley 2007) and
  the Jason `.fail_goal` API docs — read.
  <https://gki.informatik.uni-freiburg.de/teaching/ss14/multiagent-systems/mas_Jason1.pdf>
- Hindriks, de Boer, van der Hoek & Meyer, *Agent Programming with Declarative
  Goals*, ATAL 2000 — read semantics sections (blind commitment as language
  semantics). <https://ar5iv.labs.arxiv.org/html/cs/0207008>
- Braubach, Pokahr, Moldt & Lamersdorf, *Goal Representation for BDI Agent
  Systems*, ProMAS 2004 — read goal-type sections.
  <https://vsis-www.informatik.uni-hamburg.de/getDoc.php/publications/208/goalsemantics_ieee_final.pdf>
- Dastani, van Riemsdijk & Meyer, *Goal Types in Agent Programming*, AAMAS 2006
  — read (poster version). <https://doi.org/10.1145/1160633.1160867>
- Duff, Harland & Thangarajah, *On Proactivity and Maintenance Goals*, AAMAS
  2006 — abstract + its treatment in Harland et al., *An operational semantics
  for the goal life-cycle in BDI agents* (JAAMAS 2014), which I read in part.
  <https://starlab.ewi.tudelft.nl/papers/n108.pdf>
- Schut & Wooldridge, *The theory and practice of intention reconsideration*,
  JETAI 2004 — read experimental sections.
  <http://www.cs.ox.ac.uk/people/michael.wooldridge/pubs/jetai2004.pdf>
- van Riemsdijk, Dastani & Meyer, *Dynamics of Declarative Goals in Agent
  Programming*, DALT 2004 — read commitment sections.
  <https://intimate-computing.net/my-papers/2005/dalt04.pdf>

LLM-BDI (2024–2026):

- Ichida, Meneguzzi & Cardoso, *BDI Agents in Natural Language Environments*
  (NatBDI), AAMAS 2024 — read.
  <https://www.ifaamas.org/Proceedings/aamas2024/pdfs/p880.pdf>
- Ciatto et al., *Exploiting GenAI for Plan Generation in BDI Agents*, ECAI
  2025 — read. <https://cris.unibo.it/bitstream/11585/1026414/3/FAIA-413-FAIA251223.pdf>
- Gatti, Mascardi & Ferrando, *ChatBDI: Natural Language Interaction Between
  Humans and BDI Agents*, ECAI 2025 — abstract.
  <https://ebooks.iospress.nl/doi/10.3233/FAIA251242>
- Visser et al., *Integrating BDI agents with LLMs for reliable HRI and XAI*,
  Eng. Appl. of AI 2025 — abstract + architecture.
  <https://www.sciencedirect.com/science/article/pii/S0952197624019304>
- HADD (*Hybrid Agents with Deterministic Decisions*, 2025) — abstract; the
  epistemic-gate idea. <https://doi.org/10.5281/zenodo.20219588>

Bratman 1987 was not directly readable online; its content is represented here
through Rao & Georgeff 1995, IRMA (Bratman, Israel & Pollack 1988, *Plans and
resource-bounded practical reasoning*), and the Cohen & Levesque tradition as
cited in the above.

## 3. Mapping to LLM agentic loops

### 3.1 What the LLM collapses, and what survives

One model sampling absorbs three distinct BDI phases: **option generation**
(what could I do about this event?), **deliberation** (which do I do?), and
**means-end reasoning** (how?). Jason's `S_E`/`S_O`/`S_I` and the plan
library's unification machinery are all inside the forward pass. What does
*not* collapse — what remains architectural whether or not anyone designs it —
is the **state around the sampling**:

- **Beliefs** = everything the model is conditioned on: observed world state,
  the transcript, `AI.local` cells rendered into the stance. The BDI lesson is
  that this store deserves *curation semantics* (consistency, provenance,
  drop-on-supersession) — alchemy's "latest situation supersedes" is exactly a
  belief-revision rule, and a good one.
- **Desires/goals** = in alchemy, implicit in prose. BDI's lesson is that
  *reifying* them (even minimally) buys detection: you can only *check*
  success, failure, or violation of a goal you can name.
- **Intentions** = a run. This mapping is nearly perfect: a run is a keyed
  commitment to a task, with its own partially-elaborated "plan" (the
  transcript), suspended when quiescent (parked), resumed by events, dropped
  when settled. Alchemy independently reinvented the intention stack as "the
  conversation" — one continuous means-end elaboration.

### 3.2 Bratman's cost argument is a token-cost argument

Intentions resist reconsideration *because deliberation is expensive*. For LLM
loops the costs are literal and measurable: re-deliberating an approach means
re-reading (or re-summarizing) the transcript, breaking the prompt cache, and
burning output tokens on re-derivation. Alchemy's frozen head **is** a
commitment device — the system prompt never changes; situations are appended
diffs — chosen for cache discipline, but landing exactly where Bratman lands:
default-continue, cheap incremental belief updates.

What alchemy lacks is the *other half*: a policy for when new input warrants
**re-deliberation rather than continuation**. Today a steer just becomes a user
message; the model decides, in-context, whether to swerve — with the sunk
transcript biasing it toward continuation (an LLM's in-context inertia is a
*de facto* bold agent). Kinny & Georgeff's result predicts this fails in
fast-changing worlds and — their deepest finding — that the winning policy is
**event-filtered reconsideration**: bold by default, with named cues that force
a genuine re-plan. The cues are domain knowledge, so they belong in the charter
(prose or predicates); the *mechanism* (what re-deliberation physically is:
compaction to a fresh context carrying beliefs but not the plan-so-far) belongs
in the kernel. Bold vs cautious becomes: how much of the transcript survives a
reconsideration boundary — a compaction/attention policy, exactly as the design
question suggests.

### 3.3 Plan library vs rendered stance

Jason: an *indexed* library; the engine mechanically selects one applicable
plan per event; the rest cost nothing. Alchemy: the turn renders *all*
applicable prose and the model integrates. Two different scaling axes:

- **Jason scales in plan count** (hundreds of plans, O(matching) per cycle) but
  is brittle at the joints — context conditions must anticipate every
  situation, and integration *across* plans doesn't exist.
- **Alchemy scales in judgment** — overlapping, partially-contradictory clauses
  are resolved by the model — but pays every rendered token every tick, and a
  charter with 40 branches is a single function whose branches multiply.

The resolution is already latent in alchemy: **Skills are the plan library.**
A skill is a named, dormant recipe (prose + tools) with activation semantics;
the `skill` tool's selection-by-the-model is `S_O` performed by judgment
instead of unification. What's missing is the *trigger index*: Jason plans
carry `+!event : context` so the engine knows when a plan is even relevant.
Alchemy skills are mentioned by prose and activated by the model, but nothing
lets a charter say "this skill becomes relevant when *this event* arrives" and
have the kernel surface it then — cheap relevance filtering before expensive
judgment. That is IRMA's filtering layer, and it is the piece of BDI machinery
most obviously worth having: the charter's branch-over-`phase` in `issues.ts`
is a hand-rolled version of it.

### 3.4 Goal types name alchemy's two run shapes

The taxonomy lands with almost embarrassing precision:

- **achieve** = bounded agent run: success condition, `Refused` when believed
  unachievable, `BudgetExceeded` as resource bound. GOAL's semantics — *drop
  iff believed achieved* — is exactly the missing formal core of "quiescent
  answer = success": today quiescence (no tool calls) is a *behavioral* proxy
  for achievement, with no check that the world state was actually reached.
- **maintain** = perpetual process: no exit condition *by definition*; the
  Issues process is a maintain-goal agent over "every issue is triaged, linked,
  and driven to closure". The literature adds the part alchemy lacks: a
  maintain goal has a **condition being maintained**, and between violations
  the agent is *Monitoring* — not merely parked waiting for arbitrary events.
  A parked run wakes when the world pushes an event; a Monitoring maintain goal
  *also* wakes when the **condition is observed violated**, whoever notices,
  and (proactive form) when violation is *predicted*. Alchemy's park/wake is
  event-driven only; condition-driven waking (a poll, an invariant check) has
  no home in the model yet.
- **perform** = dispatch/spawn with no world-state success check — already
  present as the spawn worker.

The vocabulary is worth stealing because it changes what the kernel can *know*:
an `achieve` run can be asked "is your condition true?"; a `maintain` run can
never `Refuse` (nothing to give up) but can escalate a violation it cannot
repair. Today `Refused` "joins the Err channel exactly when the charter
declares a bounded exit" — the taxonomy makes that declaration first-class.

### 3.5 Declarative success conditions and `Refused`

`Refused` demands "a repeat-observed blocker across consecutive iterations,
claimed by the run and ratified by the kernel/check — never the model's bare
refusal." That is precisely GOAL's decoupling: the *procedure* (model) claims;
a *predicate over beliefs* (kernel-evaluated Effect) ratifies. The same
predicate that ratifies refusal should ratify success — single-minded
commitment needs both termination conditions. Without it, quiescence conflates
"achieved", "believes achieved", and "ran out of things to say."

### 3.6 One agent, many intentions vs many runs, no sharing

A Jason agent interleaves all its intentions over **one belief base**: what
intention A learns, intention B knows next cycle. Alchemy runs share *nothing*
— per-run locals, per-run transcript. Gained: isolation (Thangarajah et al.'s
whole sub-literature on detecting/avoiding interference between interleaved
goals is *solved by construction*), per-run cache discipline, crash blast-radius.
Lost: **cross-run knowledge**. The Issues process cannot learn "this repo's
maintainer prefers linked PRs squashed" in issue #7 and know it in issue #12.
BDI says the missing organ is the term-scoped belief base — not shared
transcript, shared *beliefs*: small, curated, rendered into every run's stance.
The Ledger is already a degenerate one (dedup facts). This is the single
clearest structural gap.

### 3.7 Failure handling

Jason's `-!g` machinery does three things alchemy currently does with model
judgment alone: (1) *names* the failure (which goal failed), (2) *unwinds* to
the nearest handler (stack discipline), (3) *retries with a different recipe,
cleanly* — the failed plan instance is discarded; the alternative plan starts
without the failed attempt polluting its context. (3) is the sharp lesson for
LLM loops: a transcript containing a failed approach biases the next attempt
toward the same approach (or toward over-correction); Jason's clean-slate
alternative-plan retry maps to *spawn a fresh worker with the beliefs but not
the transcript*. Alchemy has all the primitives (spawn, situations, typed tool
failures with `failureMode: "return"`) but no doctrine connecting them.

### 3.8 The LLM-BDI literature (2023–2026)

The recent work almost uniformly runs the integration in the *opposite*
direction from alchemy: keep the symbolic BDI cycle as the chassis, insert the
LLM at one joint. NatBDI (AAMAS 2024): plan library and beliefs in natural
language, plan *selection* via NLI entailment, RL fallback when no plan is
applicable — the plan library measurably beats pure learned policies, i.e.
**human-authored recipes retain value even when the selector is neural**.
Ciatto et al. (ECAI 2025): the LLM *generates plans into the library* at
runtime (on-demand or on plan-failure), keeping the AgentSpeak cycle intact —
generated plans become reusable artifacts, amortizing sampling cost; their
boundary analysis (what agent state gets serialized into the prompt) is the
same problem as alchemy's stance rendering. ChatBDI (ECAI 2025): LLM as
language actuator only. HADD (2025): an *epistemic gate* between LLM output
and the belief store — verify before you believe, because a hallucination that
enters beliefs contaminates all downstream deliberation. Visser et al. (2025):
BDI as the verifiable core, LLM as interpreter/explainer, using the explicit
mind-state (beliefs, plan library, event history) to *generate explanations* —
a reminder that reified mental state is also an observability win.

The consistent finding: LLM judgment is strongest at *interpretation and
generation*; symbolic structure is strongest at *lifecycle bookkeeping*
(what's committed, what failed, what's monitoring). Nobody in this literature
has alchemy's problem-shape (LLM as the whole deliberator, structure as the
harness) — which means alchemy is the experiment the field hasn't run, and the
BDI lifecycle lessons are the priors to take seriously.

## 4. Comparison with alchemy's charter/stance/kernel model

The correspondence, term by term:

| BDI | Alchemy | Fidelity |
|---|---|---|
| Intention (plan stack) | Run (keyed transcript + locals) | Strong |
| Belief base | Transcript + situations + `AI.local` | Partial — no cross-run store, no curation beyond supersession |
| Plan library | Skills + charter branches | Partial — no trigger index |
| Event queue | Mailbox (`send`/`steer`) | Strong |
| `S_O` plan selection | Model judgment over rendered stance | Deliberate replacement |
| Intention suspension | Park at quiescence | Strong — but wake is event-only, never condition-driven |
| drop-successful / drop-impossible | `settle` (world) / `Refused` (run) | The world outranks beliefs — *better* than BDI here |
| Commitment strategy | Frozen head + in-context inertia | Implicit, unnamed, un-tunable |
| `-!g` failure plans | Tool failure returned to model | Weaker — no clean-slate alternative retry |
| Maintain goal | Perpetual process | Missing the maintained *condition* |
| Meta-level KAs | Kernel policy (compaction, budget) | Rightly kernel-side, but reconsideration policy absent |

**Where prose + judgment legitimately replaces BDI machinery.** Plan selection,
context-condition evaluation, and means-end reasoning — the parts BDI
implemented with unification over ground literals because 1995 had nothing
better. The model does these with actual world knowledge; mechanizing them
would be regression. Likewise the `settle` semantics ("the world outranks the
org's beliefs") is *stronger* than BDI's drop-successful, which trusted the
agent's beliefs; and capability-by-omission through the R channel is a
constitutional guarantee no BDI system had (their "screen of admissibility"
was advisory; alchemy's is type-level).

**Where 30 years of BDI predicts pain, concretely:**

1. **No reconsideration policy.** In-context inertia makes every run a bold
   agent; Tileworld says bold agents degrade precisely when the world moves
   fast — which for the org is "the issue author pushes three corrections while
   the Engineer is mid-plan". The failure mode is not dramatic; it is quiet
   doubling-down, visible only as wasted tokens and stale work.
2. **Quiescence conflates success with silence.** No declarative achieve
   condition means the kernel cannot distinguish "done", "thinks it's done",
   and "stopped". GOAL's iff-semantics is the fix and it is cheap.
3. **Perpetual ≠ maintain.** A parked Issues run wakes only when GitHub pushes
   an event. The condition it exists to maintain can rot silently (a PR merged
   whose issue never closed; an author reply lost to a webhook redelivery
   window). Maintenance semantics say: name the condition, monitor it, wake on
   violation — not only on mail.
4. **No cross-run beliefs.** Every run relearns the world. §3.6.
5. **Failed approaches poison transcripts.** §3.7. Jason's clean-slate
   alternative-plan retry has no counterpart; long runs accumulate failure
   residue that compaction (when it exists) must launder.
6. **Charter branch complexity.** Rao & Georgeff's "essential features" list
   praises incremental plan addition *without modifying existing plans*.
   Alchemy's turn is one function; at 10 phases × 5 event kinds it becomes the
   god-switch the plan library was invented to decompose. Skills + a trigger
   index restore AgentSpeak's modularity.

## 5. Steal / adapt / reject

### 5.1 STEAL: goal-type vocabulary — `AI.achieve` / `AI.maintain`

Make the run's goal type a declared, kernel-visible fact with a declarative
condition. In alchemy's idiom (sketch):

```ts
// Bounded: an achieve-run. `until` is GOAL's success predicate —
// evaluated by the kernel at each quiescence; quiescence alone no
// longer resolves dispatch waiters.
export const EngineerCharter = AI.achieve({
  until: Effect.gen(function* () {
    // predicate over observed world state, not the model's claim
    const pr = yield* FindOpenPullRequest(yield* AI.runKey);
    return pr !== undefined && pr.checks === "green";
  }),
  // Refused ratification: same predicate family, inverted —
  // evidence = the blocker observed on N consecutive quiescences.
  refuseAfter: { observations: 2 },
})(AI.prose`You receive exactly one ${issue}. ${Coding} is your craft...`);

// Perpetual: a maintain-run. `invariant` names the condition the run
// exists to keep true. The kernel checks it on wake AND on a poll
// schedule — condition-driven waking, not just event-driven.
const charter = AI.maintain({
  invariant: Effect.gen(function* () {
    const issue = yield* GetIssue(yield* AI.runKey);
    return issue.state === "closed" || !isStale(issue);
  }),
  onViolation: "wake", // park-break: violation is a synthetic situation
})(Effect.gen(function* () { /* existing init → turn */ }));
```

Payoffs: `Refused` becomes typed exactly on achieve-runs (already the intent —
"only `until`-halted loops can refuse"); maintain-runs get Monitoring
semantics instead of pure event-driven parking; the kernel can answer "is this
run's condition true?" without sampling. The conditions are ordinary Effects —
testable with a mock world, no model in the loop.

### 5.2 STEAL: a reconsideration policy (commitment as a kernel knob)

Name the bold–cautious spectrum and implement rational commitment as
event-filtered re-deliberation:

```ts
const charter = AI.commitment({
  // Kinny–Georgeff cues: which inputs force re-deliberation instead
  // of mere appending. Typed events make the filter cheap and exact.
  reconsiderOn: [GitHub.IssueEdited, AcceptanceCriteriaChanged],
  // What re-deliberation IS: compact to beliefs, drop the plan-so-far.
  // "bold" = never; "cautious" = every steer; default = cues only.
  mode: "rational",
})(EngineerCharter);
```

Mechanically, reconsideration = the kernel folds the transcript to a belief
summary (what was learned, what was tried, what failed), re-runs the turn,
starts a fresh sampling context seeded with beliefs + the triggering input.
This is exactly "bold vs cautious as a compaction policy," with the cues in
charter space (domain knowledge) and the mechanism in kernel space — PRS's
meta-level KAs, but owned by the kernel, not the user.

### 5.3 ADAPT: Jason failure semantics → clean-slate alternative retry

Keep tool failures model-visible (current design is right and matches Jason's
return-to-deliberation). Add the missing discipline for *approach-level*
failure: when the stall detector fires or an explicit `abandon_approach` inline
tool is called, the kernel (a) records the failed approach as a belief
("approach A failed because X — do not retry it unchanged"), (b) re-deliberates
per §5.2 with that belief injected. That is `-!g` + alternative-plan selection,
with the model as `S_O`. The `Refused` evidence bar falls out: two consecutive
failure-beliefs about the same blocker *is* the "repeat-observed blocker."

### 5.4 ADAPT: a term-scoped belief base

`AI.local` is run-scoped; add the term-scoped sibling with curation semantics
(HADD's lesson: gate what enters):

```ts
const facts = yield* AI.shared<Fact[]>("repo-facts", []); // INIT, term-scoped
// turn: render a bounded digest into every run's stance
return AI.prose`Known about this repository: ${facts.digest(10)}`;
// runs write through an inline tool; writes are appends with provenance,
// superseded facts are dropped by key — belief revision, not a log
```

Start read-mostly and small (it renders into every stance; unbounded beliefs
are unbounded tokens). This is Jason's shared belief base with alchemy's
isolation preserved: runs share *facts*, never transcripts.

### 5.5 ADAPT: trigger-indexed skills (the plan-library index)

Let a skill declare relevance: `AI.Skill<Fixing>()("Fixing", { on: CIFailed })`.
The kernel then surfaces the skill (mentions it in the stance, or pre-activates
it) only when a matching event is in the run's inputs — IRMA's cheap filter
before expensive judgment. Charters shrink: event-conditional branches move out
of the turn's `if`-tree into the skills' triggers, restoring AgentSpeak's
add-a-plan-without-touching-others modularity.

### 5.6 REJECT

- **Mechanical plan selection** (`S_O` by unification) and symbolic belief
  logic — the model is a better judge, and ground-literal belief bases were a
  limitation, not a virtue.
- **Interleaved multi-intention within one agent/transcript.** Isolation is the
  right call; BDI's goal-interference literature is a catalog of bugs alchemy
  cannot have. Cross-run needs are met by §5.4, not by sharing execution state.
- **User-programmable meta-level (PRS meta-KAs).** Reconsideration and
  compaction are kernel policy with charter-declared *parameters* (§5.2);
  exposing the meta-level as user prose reintroduces the reflective-tower
  complexity that sank PRS's usability.
- **A goal *stack* reified outside the transcript.** The transcript already is
  the intention's means-end elaboration; duplicating it as symbolic structure
  (as some LLM-BDI hybrids do) creates a second source of truth that drifts.

## 6. Open questions

1. **Who evaluates achieve-conditions, and how often?** Every quiescence is the
   obvious point, but conditions that call the world (CI status) have cost and
   eventual-consistency windows. Is a condition-check failure a belief or an
   error?
2. **Reconsideration vs prompt-cache economics.** Re-deliberation deliberately
   burns the cache. Is the fold-to-beliefs summary produced by the model (costs
   a sampling, risks confabulated beliefs — HADD's gate applies) or
   mechanically (lossy)? Measurement needed: does clean-slate retry actually
   outperform in-context correction at current model quality?
3. **Proactive maintenance.** Duff et al.'s *predictive* violation needs a
   lookahead mechanism. Is "the model, asked at quiescence whether the
   invariant is at risk" a legitimate π, or does that reintroduce bare-refusal
   noise the evidence bar was designed to exclude?
4. **Shared beliefs and durability.** A term-scoped belief base is exactly the
   state a durable kernel must persist and a test kernel must seed. Does it
   subsume the Ledger, or sit beside it?
5. **How far does the trigger index go?** Full AgentSpeak (`event × context →
   skill`) risks rebuilding the brittleness the model was hired to avoid.
   Where is the line between cheap relevance filtering and brittle mechanical
   selection?
6. **Intention structure across delegation.** Dispatching the Engineer creates
   a child intention invisible to BDI semantics (the parent's transcript just
   has a tool call). Should the kernel track the intention *tree* — for
   interruption cascades, budget attribution, and the day two runs' intentions
   conflict over the same world resource?
