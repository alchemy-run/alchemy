# Reassessing exit conditions — perpetual vs goal-oriented processes

A design-research report answering: is the Channel kind's `AI.until(S.String)` a
modeling error in the org, or a gap in the Process/Halt abstraction? Prompted by
three observations from the project owner: (1) the Channel's exit reads like the
exit of a *Post*, not the channel; (2) a Channel could be a deterministic API
that triggers Thread processes; (3) a Post might have no exit at all, while a
GitHub Issue has a crisp one (closed) — that it does not own.

Sources: `alchemy-ai-design.md` (§1.2.2, §1.5, §2.5, §2.9, §8.2),
`org-chat.md`, `reports/agent-loop-algebra.md`, `src/AI/{Process,Halt,Trigger}.ts`,
`src/AI/KernelMemory.ts` (halt-as-tool), `examples/agent-chat-web/src/org.ts`,
`test/AI/fixtures/org/processes.ts`, AGENTS.md (reconciler doctrine).

---

## 1. The taxonomy — real-world entities and their exits

| Entity | Perpetual or goal-oriented | Exit crisp or fuzzy | Re-enters? | Who declares the exit |
|---|---|---|---|---|
| Chat channel (`#engineering`) | **Perpetual** — exists while the org does | — (no exit; health signals instead) | — | Nobody. Archival is an admin act *on* the entity, not a resolution *by* it |
| Post / thread in a channel | Goal-oriented in a work channel ("question answered"); **often exitless** in a casual one — it just goes quiet | **Fuzzy** — "needs nothing more" is judgment | Yes — anyone can reply to a dormant thread | The room (a model, in our case), or quiescence (nobody declares anything) |
| Discord thread | Same as Post; platform adds *auto-archive* — a timeout, not a resolution | Fuzzy (resolution) + crisp (archive timer) | Yes — unarchives on reply | Model/human for "resolved"; the platform clock for "archived" |
| GitHub Issue | Goal-oriented: exists to be closed | **Crisp** — `state: closed` is machine-checkable | **Yes** — `reopened` is a first-class event | **The entity's own state machine.** A human or bot closes it; the process working on it does NOT get to declare it done |
| Pull request | Goal-oriented: merged or closed | Crisp — `merged`/`closed` state | Rarely (reopen exists but a merged PR is final) | The entity's state machine (merge = human/CI-gated act) |
| Support ticket | Goal-oriented, with a twist: "resolved" often needs requester confirmation or an auto-close timer; SLA is a *deadline*, not an exit | Semi-crisp — status field is crisp, whether the problem is actually solved is fuzzy | Yes — reopened on customer reply | Mixed: agent proposes, requester/timer disposes. SLA breach is a machine-observed *escalation*, not an exit |
| On-call rotation | **Perpetual** (the rotation); each *page* is a goal-oriented incident | Incident exit semi-crisp (monitors green + human declares "resolved") | Incidents recur; the rotation never exits | Rotation: nobody. Incident: monitoring system + incident commander |
| CI pipeline run | Goal-oriented, **fully mechanical** | **Crisp** — the run terminates by construction | No — a re-run is a new run | The machine alone. No judgment anywhere |
| "Keep the tests green" mandate | **Perpetual** standing responsibility | — (health signal: the suite's state) | — | Nobody; each *red-suite episode* it spawns is goal-oriented with a crisp machine exit (suite green) |

Three structural lessons fall out:

1. **Perpetual entities and goal-oriented episodes come in pairs.** The channel
   hosts posts; the rotation hosts incidents; the mandate hosts red-suite
   episodes; the repo hosts issues. The perpetual thing never exits — it has
   health signals (`AI.never`'s existing contract). The episode exits. Every
   confusion in the current org comes from writing the episode's exit on the
   perpetual thing's term.
2. **Exit declaration has exactly three sources**: the model working the episode
   (fuzzy judgment — "the Post is resolved"), an external state machine
   (crisp observation — issue closed, suite green, PR merged), or a human
   (verdict — incident commander, ticket requester). §8.2 already says exits
   ascend "mechanical → model → environment → eval → human"; the taxonomy
   confirms these are *sources*, not rungs of quality.
3. **Re-entry is a property of the world entity, not of the run.** Issues
   reopen, threads get late replies, tickets bounce back. The entity's identity
   persists across episodes; each episode is a fresh convergence attempt.

## 2. The diagnosis — the org model is wrong; the abstraction is half-right

**Be decisive: the algebra is not broken. The org example misassigned one layer,
and the Halt abstraction is missing two of the three exit sources.**

First, what the algebra already gets right — and this is easy to miss:
`Out` is **run-scoped** (`Process.ts`, design §1.2.1: "a run is the loop applied
to one work item; the ring never resolves"). So `AI.until(S.String)` on the
Channel kind *already* types the exit of each Post-run, not of the channel —
the ring's `run(): Effect<never>` is perpetual regardless of the halt. The
owner's intuition ("that seems more like the exit condition of a Post") is
correct, and the type system secretly agrees. The ring/run split IS the
perpetual/goal-oriented split, derived not declared.

So why does it still feel wrong? Three real defects:

1. **One term carries two nouns.** The `Channel` term is simultaneously the
   perpetual entity (the ring, the sidebar item, the thing with members) and
   the episode template (the per-Post charter with a halt and an 8-iteration
   budget). The charter prose addresses the channel ("You are the #general
   channel…") while its control refs describe a Post. `org-chat.md` §2 had it
   right — a channel is `AI.on(Message)` + `AI.never` — and the shipped
   example silently swapped `AI.never` for `AI.until(S.String)` to make Posts
   settle. The fix is not to choose; it is to give each noun its term: a
   perpetual Channel process (or no process at all — below) and a
   goal-oriented **Post/Thread** process the channel dispatches.
2. **The channel's coordination is on the wrong side of the determinism line
   for half its duties.** §2.9: occurrence is deterministic, judgment is fuzzy.
   "A message for thread t-123 steers run t-123" is *exact* — kernel routing,
   no tokens. "Should this open a thread? who should answer?" is *judgment*.
   The current Channel process burns a model run on both. The owner's
   alternative ("a deterministic API that triggers a Thread process") is right
   for the exact half and wrong for the fuzzy half — org-chat R4 already
   drew this boundary and the example ignored it.
3. **The abstraction gap: halt-as-tool is the only implemented exit.** §2.5:
   the kernel injects synthetic `resolve`/`give_up` tools; the model calls
   `resolve`; the check grades it. Every exit today is **model-declared**.
   The design doc *claims* parity ("a maintainer closes the experiment is a
   halt signal arriving as a GitHub event, exactly like `${Bash}` reporting
   green" — §1.2.2 design notes) but nothing wires it: a `Halt` template can
   interpolate Tools, not EventSources, and there is no exit-by-observation.
   `Autoresearch`'s `AI.until\`a maintainer closes the experiment\`` type-checks
   and then waits for the *model* to notice and call `resolve` — the exact
   confabulation the check machinery exists to prevent, relocated to the exit.

Is a new concept ("engagement"/"case" — a run with identity, state, lifecycle)
needed? **No.** The kernel already keys a run by `(term, work item)` — world
identity rides in `In` (a thread id, an issue number). A case *is* a run key
plus its Trace; §9.5's "no durable run object is ever resurrected" says the
lifecycle is derivable, and re-entry (below) composes from re-admission + the
fold. Inventing a Case entity would re-create Codex's Session god-object.
What's missing is only: (a) exits with machine/human sources, and (b) a
defined re-admission semantics for a settled run key.

## 3. GitHub Issues — the exemplar, designed on paper

The repo is the perpetual entity; each issue is a goal-oriented episode whose
exit is **owned by GitHub's state machine**, not by the process working it.

```ts
// events (IssueOpened/IssueLabeled exist in the fixtures; add:)
Github.IssueClosed(repo)    // EventSource<{ number, reason, by }>
Github.IssueReopened(repo)  // EventSource<{ number, by }>
Github.IssueCommented(repo) // EventSource<{ number, author, body }>

// the episode: one issue, converge until the WORLD says closed
export class IssueWork extends AI.Process<IssueWork>()("IssueWork")`
One issue. Reproduce it, fix it or answer it, open a PR if code must
change (${OpenPullRequest}), and reply on the issue (${Comment}). You
may close the issue yourself with ${CloseIssue} when the fix is
verified — but closing is an act in the world, not a claim to me.

${AI.each(issue)}
${AI.until(Github.IssueClosed(repo))`the issue reaches state: closed —
whether you closed it, a maintainer did, or it was closed as duplicate`}
${AI.check((t) => verifyLinkedPrMergedOrAnswerAccepted(t))}
${AI.budget({ iterations: 12, wallClock: "4h" })}` {}

// the perpetual side is ROUTING, not a coordinator process:
// IssueOpened → issueWork.send(issue); IssueCommented → steer by run key;
// IssueReopened → re-admit the same key (§5). Deterministic — no ring.
```

The load-bearing line is the halt: `AI.until(Github.IssueClosed(repo))`. The
run does not end when the model calls `resolve` — there is no `resolve` tool
compiled for a source-halt. The run ends when the subscribed event arrives
(correlated by the run's world identity, `issue.number`), and `Out` is the
event's payload. The model's `CloseIssue` tool call is just *a way of causing
that event* — action in the world, confirmed by observation of the world.

This is the reconciler doctrine (AGENTS.md) transposed: **observation >
assumption; the provider's claim of done-ness is not a signal; read back the
observed state**. `reconcile` never returns "I believe I created the bucket" —
it re-reads. Halt-as-tool is the IaC anti-pattern of trusting the create call's
success; halt-as-observation is `AI.until` as a *convergence* condition:
desired state "issue closed (properly)", observed state GitHub's, the run loops
until they meet. The maker/checker split applied one level up: today the check
grades the model's claim; a source-halt removes the claim entirely for
entities that own their state.

Failure modes stay typed: the budget still fires (`BudgetExceeded` — issue not
closed within the lease); `give_up` stays (`Refused` — "cannot reproduce,
needs reporter input") which the routing layer can turn into a label + comment,
parking the episode until `IssueCommented` re-admits it.

## 4. The exit-source trichotomy

Make the halt's *source* explicit. Three constructors, one `Halt` ref kind, all
deriving `Out` exactly as today:

| Source | Constructor | Mechanism | `Out` | Today |
|---|---|---|---|---|
| **Model-declared** | `AI.until(schema?)\`prose\`` | halt-as-tool (`resolve` + `give_up`), check grades the claim | schema type / `void` | ✅ landed |
| **Machine-observed** | `AI.until(eventSource)\`prose\`` or `AI.until(machinePredicate)` | run settles when the correlated event arrives / the pure predicate over the Trace+world holds; no `resolve` tool compiled | event payload / predicate's type | ❌ missing (doc claims it; nothing wires it) |
| **Human-declared** | `AI.until(AI.ask(schema))\`prose\`` | the Ask protocol in halt position: park until a verdict answers | verdict type | ❌ missing (Ask exists; not composable into Halt) |
| (perpetuity) | `AI.never\`health signals\`` | no exit; ring serves forever | `never` | ✅ landed |

Notes:

- This mirrors what `AI.check` already did: the check slot takes *arrows*, fuzzy
  or machine (`MachineCheck`, §2.9). The halt slot should take *sources*. The
  symmetry with Trigger is exact and pleasing: `AI.on(source)` derives `In`
  (what wakes a run); `AI.until(source)` derives `Out` (what settles it). An
  EventSource in halt position contributes its channel tag to `Req`, exactly
  like a trigger — declaring the exit subscription provisions the wire.
- Human-declared is *almost* a special case of machine-observed (a human click
  arrives as an event), and for GitHub it literally is (maintainer closes →
  `IssueClosed`). Keep it distinct only where the Ask protocol's park/verdict
  semantics are wanted (approval-shaped exits with amendments). Bounded-by-human
  and bounded-by-machine being "the same type" survives — they now also have
  the same *wiring*.
- Lint: a source-halt with no budget stays `unbounded-until` (the event may
  never come); a source-halt plus `AI.check` is legal (the check can gate
  *cause* — e.g. refuse to let the model close its own issue without a merged
  PR) but the check no longer owns the exit.

## 5. Re-entry — what run identity already answers

Reopening must NOT resume the settled run. §9.5 is unambiguous: "a run is
active is derivable; no durable run object is ever resurrected." A settled
run's fibers, budget lease, and join seats are gone; resurrecting them is the
Codex-Session trap. Instead:

- **Same key, new run.** `IssueReopened` re-admits the same world identity
  `(IssueWork, issue#42)`. The admission ledger records a new attempt under the
  key; the Trace under that key is continuous.
- **The fold is the bridge.** §0.8: "the fold is the unit of both memory and
  durability." The new run's seed is the fold over the prior episode's trace —
  the new attempt starts knowing what was tried, why it was believed closed,
  and what the reopen said. This costs nothing new: it is exactly the
  recovery path (`Resume` policy) applied to a *voluntary* re-entry, and
  Flywheel's charter already gestures at it ("a rejected review reopens the
  originating Fix run with the review attached as new acceptance criteria").
- Budget is per-episode (a fresh lease), not per-key — an issue reopened five
  times is five bounded attempts, each escalatable, never one immortal run.

## 6. Recommended changes

**The corrected org model** (each entity classified):

| Entity | Term | Trigger | Halt |
|---|---|---|---|
| Channel | *No process for routing* — deterministic event routing (message → thread run key). Optionally a perpetual coordinator process (`AI.never`) ONLY where routing is judgment (who answers? open a thread?) | `AI.on(ChannelMessage)` | `AI.never` (health: response rate) |
| Post/Thread (work channel) | Its own kind, dispatched per post; follow-up messages steer by run key | dispatch-driven | `AI.until(S.String)` — model-declared, check-graded (the current Channel halt, moved down a layer) |
| Post (casual channel) | Kernel-default conversation (Agent semantics) | dispatch-driven | none — quiescence; the run parks, late replies steer it |
| GitHub Issue | `IssueWork` (§3) | `AI.each(issue)` fed by `IssueOpened` | `AI.until(Github.IssueClosed(repo))` — machine-observed |
| PR review | process per PR | `AI.on(PullRequestOpened)` | `AI.until(Github.PrMergedOrClosed(repo))` — machine-observed |
| Standing mandate ("tests green") | perpetual process | `AI.on(CiFailed)` | `AI.never`; each red-suite episode is a dispatched run halting on `AI.until(suiteGreen)` — machine predicate |

**Abstraction changes** (small, in dependency order):

1. **Halt sources** — extend `Halt` with `source: EventSource | MachineCheck |
   Ask | undefined` (undefined = today's halt-as-tool). `ProcessOut` derives
   from the source's payload; `Services` extraction lets a halt's EventSource
   contribute its channel tag. Kernel: for a source-halt, compile no `resolve`
   tool; subscribe the source at interpretation, correlate by run key, settle
   the run on arrival (the completion is an admission, racing the in-flight
   iteration like a steer). ~Trigger-sized change.
2. **Re-admission of a settled key** — define it in the kernel: new run, same
   key, fold-seeded from the key's trace, fresh budget lease. (This also fixes
   the "rejected review reopens the Fix run" prose, which today has no
   mechanism.)
3. **Fix the org example** — split the Channel kind: keep the coordinator only
   for the fuzzy duties, introduce a `Thread` kind carrying the
   `AI.until(S.String)` halt and the iteration budget, route follow-ups as
   steers by run key (the R2/R4 work org-chat already scheduled).
4. **No new Case/Engagement entity.** Run identity + Trace + fold already are
   the case file; adding a durable lifecycle object would violate §9.5 for no
   new power.

The one-sentence version: **perpetual entities are rings (or mere routing) and
must say `AI.never`; goal-oriented episodes are runs with their own term; and
an exit belongs to whoever actually owns it — the model only when nobody
better exists, the world's state machine whenever there is one.**
