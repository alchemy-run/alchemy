# Reassessment: did we over-generalize Agent into Process?

Focused review of the Process abstraction, prompted by the owner:
*"maybe haven't got how to use it down, or maybe have gone too far with
Processes and should have just had Agents"* and *"it looks like maybe a bit
too much is reliant on an LLM making every decision."* Method: evaluate both
interpretations against the code (`src/AI/{Process,Agent,Kernel}.ts`), the org example
(`examples/agent-chat-web/src/{org,server}.ts`), the design (§1, §2.9, §8),
and the four sibling reassessments. Conclusion at the end.

---

## 1. Evidence that the abstraction went too far

**1.1 Inventory the surface a user is asked to learn.** Beyond Agent + Tool +
EventSource, the Process abstraction adds: charters (prose with a splice
protocol, `Process.ts:241-275`), two halt constructors (`AI.until`/`AI.never`),
three trigger constructors (`AI.on`/`each`/`every`), `AI.budget`,
`AI.check`, `AI.fold`, `AI.concurrency`, `AI.observe`, the kind machinery
(`AI.Process(name, definition)` + `AI.charter` + `AI.body`,
`Process.ts:278-341`), and three derived channels (`ProcessOut/In/Err`,
`Process.ts:74-113`). That is ~12 constructors and a macro system. Now audit
who actually authors each of them:

| Piece | Authored by a user in the shipped example? | Classification |
|---|---|---|
| charter prose | yes (`org.ts:45-67`) | user-facing — but §3 argues it's doing code's job |
| `AI.until` | once, inside the kind (`org.ts:66`) | user-facing, load-bearing (types `Out`) |
| `AI.budget` | once (`org.ts:67`) — and renders **nowhere** (control-refs §1) | config wearing a prose costume |
| `AI.on/each/every` | **zero uses** in the example; fixtures only | user-facing in theory |
| `AI.check` / `AI.fold` | **zero uses** outside test fixtures | kernel hylo parameters, reified |
| `AI.concurrency` | zero; when used, the `3` evaporates from prose (control-refs §1) | config in costume |
| kinds / `spliceCharter` | once (the Channel kind) | macro system for one macro |
| `run()` / rings | never called by users; `server.ts` never serves a ring | kernel machinery |

The pattern the table shows: **the parts of Process that users demonstrably
author are prose + one exit + one budget.** Check, fold, concurrency, and the
ring are the kernel's hylomorphism parameters (algebra report §1.3) surfaced
as term vocabulary. The renderer already reflects this: control refs render
as the empty string (`Render.ts`, control-refs §1c) — the halt re-enters via a
kernel-appended `# Halt condition`, the budget is never shown to the model at
all. *The prose was never the configuration for these refs.* That is the
signature of an implementation detail leaked into the API.

**1.2 The alternative vocabulary is sufficient for everything shipped.** The
deterministic-orchestration report shows the org's one real Process (the
Channel) is ~30 lines of plain Effect: route with a regex or a
`generateObject` leaf, `Effect.all` the members' `dispatch` calls, post
replies via `ctx`, return the resolution (det-orch §4). Agent + Tool +
EventSource + Effect code covers the example completely. Every surveyed
framework converged on exactly that shape — agents as typed async functions
called from ordinary code; "nobody invented a prose coordinator" (det-orch
§1). On this reading Process-as-term is a solution looking for its problem:
the only charter in the example is the one the siblings recommend rewriting
as code.

**1.3 Where that leaves Process:** not deleted — demoted. The thing every
consumer actually touches is `ProcessService` (`Process.ts:50-61`): five verbs
that `server.ts:54-77` wires into ChatSessions without caring whether prose or
code sits behind the tag. The *term* — prose interpreted by the kernel with
reified control refs — would be the rare, opt-in authoring mode.

## 2. Evidence for keeping Process

**2.1 The typed goal run is not free, and Agent doesn't have it.** A bare
Agent turn has `Out` = an opaque message, `Err = never`, no budget, no halt,
no check (`Agent.ts:56-81` — kernel defaults, deliberately not terms). The
things a goal job needs — `dispatch(item): Effect<Out, Err>` with `Out`
derived from the halt schema and `Err = BudgetExceeded | Refused`
(`Process.ts:74-113`) — are this framework's genuine novelty: no surveyed
system types its stop condition (control-refs §4; the AI SDK's
`result.output` *throws* when stopped via tool call). "Just write Effect code
that calls agents" does not reproduce it: the caller would hand-roll
halt-as-tool compilation, check grading, fold seeding, budget grading,
`run.settled`, steer-at-iteration-boundary, and re-admission — precisely the
boilerplate audit in det-orch §3. The goal-oriented run is a real object users
want *delivered*, even when they don't author its parameters one by one.

**2.2 Term vs shape — the distinction that clarifies the question.**
Split the word "Process":

- **(b) Process-as-service-shape** — `ProcessService<Out, In, Err>`. This is
  load-bearing everywhere and remains under either conclusion: it is the unit of
  composition (`server.ts`), the thing code-implemented and prose-implemented
  tags share (perpetual §3.1), and the reason a deterministic Channel can
  delegate to a prose Thread and vice versa. Nobody proposes deleting this.
- **(a) Process-as-term** — a prose charter the kernel interprets. This is
  what the "too far" concern actually refers to. Even here, there is
  one irreducible use: **open-ended coordination**, where the action set
  isn't enumerable in advance (the support room that might file an issue,
  escalate, or ask a clarifying question — det-orch §4 end). When
  coordination is genuinely agentic, the charter + typed exit + budget + check
  *is* the right artifact, and no `switch` statement can be written.

**2.3 Collapsing to just-Agent would recreate the problem elsewhere.** Eve
bolted "task mode" onto a conversation agent and the modal split leaked into
a dozen code paths (algebra §2.3). If Agent were the only term, the first user
who needs a typed exit would demand halt/budget/check back — as untyped
runtime options, which is strictly worse than the current derivation.

## 3. Assessment of LLM reliance

The concern applies **to the example and the defaults**, not to the capability
set:

1. **Relay-by-model.** The Channel charter instructs the model to copy each
   member's reply into the thread via `${PostReply}` "verbatim unless very
   long" (`org.ts:58-60`). A model turn spends tokens copying a string —
   pure mechanics, `ctx.post` in code.
2. **Routing-by-model.** "Decide which member(s) should handle it"
   (`org.ts:55-57`) is a per-Post coordinator turn where a regex or one
   `generateObject` classifier leaf with a typed fallback suffices
   (det-orch §4). At `iterations: 8`, that is 4–8 coordinator turns per Post
   to do a `switch`.
3. **Prose guarding against failure modes code cannot have.** "You NEVER
   write prose into the thread" (`org.ts:47-50`) exists only because the
   coordinator is a model; the deterministic variant cannot produce this behavior.
4. **The default is the LLM even though the doctrine isn't.** §2.9 already
   says occurrence is deterministic; the kernel's `AI.never` arm is already
   deterministic machinery serving single default turns
   (`KernelMemory.ts:896-931`, perpetual §0.3) — a standing LLM loop
   doesn't exist in the implementation. But the only *shipped authoring path*
   for a triggered process is a charter: `AI.process(term, handler)` is still
   a proposal, `Layer.effect(tag, …)` by hand costs five verbs plus Trace
   plumbing (det-orch §3), and the first thing a new user sees (`org.ts`) is
   an LLM doing `if/else`. The CAPABILITY is fine; the DEFAULT and the
   tutorial are wrong.

Correct defaults: message-to-run-key routing is kernel-exact (steer if the
thread's run key matches, else new run — perpetual §3.3); coordination is
code by default; LLM calls are opt-in leaves (classifier `generateObject`, or
a goal charter where judgment is the work); perpetual-LLM-loops are not a
thing at all (perpetual §1.3 — there is no fourth row).

## 4. Synthesis with the sibling reports

Taken together, the four sibling reports point toward the same response to the
"too far" concern:

- **det-orch**: Effect is the workflow language; `AI.process(term, handler)` +
  `ProcessContext` + prose-free terms make code the cheap, visible default.
- **control-refs (shape C)**: control *wiring* moves to a structured config
  argument; prose stays inside halt/check/fold values. This deletes the
  tacked-on template tail — the single strongest piece of evidence for the
  configuration-in-prose concern — without losing the typed channels (inference gets
  simpler: keyed lookup instead of `Extract` over a tuple).
- **exit-conditions**: halts gain machine/human sources, so goal jobs stop
  pretending the model owns exits it doesn't (`AI.until(Github.IssueClosed)`).
- **perpetual-vs-goal**: servers are derived topology, jobs are work;
  `AI.never` narrows to the conversation shape; lints forbid the incoherent
  combinations.

After those four land, what remains of Process-as-term is exactly its
supported core: **a prose-charted, budgeted, judged, typed-exit goal job** —
authored when the work is genuinely agentic, and rarely otherwise. The
residual simplification is real but small: it is *presentation*, not
structure. No further merge is available — folding Process into Agent loses
the typed run (§2.1); splitting into `Agent`/`Job`/`Daemon` reifies
`Daemon`, which the perpetual report correctly rejects (a server is `serve`'s
output, never a kind); renaming Process to `Job` misnames the conversation
shape the same term legitimately carries. The concept count is already
minimal; the *default path through the concepts* was the bug.

## 5. Conclusion

**The surface and defaults are over-generalized; the architecture is not.**
The minimal vocabulary, named precisely:

| Concept | Status | What it is |
|---|---|---|
| `Tool`, `Parameter`, `EventSource` | **keep** | capabilities and wires |
| `Agent` | **keep** — the common term | an LLM with tools; kernel-default process |
| `ProcessService` | **keep** — the universal shape | the five verbs every tag resolves to; the unit of composition |
| plain Effect code + `AI.process(term, handler)` | **build & promote to default** | deterministic orchestration; agents called as typed functions |
| `Process` (the term) | **keep, demote to opt-in** | prose-charted goal job with typed exit/budget/check — authored only when coordination is genuinely agentic |
| control refs in the template tail | **delete** (→ config, shape C) | wiring the renderer already erased |
| `AI.check`/`AI.fold`/`AI.concurrency` | **keep as config values**, stop teaching early | hylo parameters; expert knobs |
| perpetual-LLM-loop as a pattern | **delete from the vocabulary** | never existed in the kernel; must not exist in the docs |
| `Daemon`/`Server`/`Job` as new kinds | **do not add** | derived, not authored |

No concept rename. `Agent` and `Process` are the right two names, with the documented
relationship "Agent is the kernel-default Process" kept as an implementation
truth rather than a teaching order. The teaching order inverts: Tool → Agent →
call agents from Effect code → `AI.process` handler → and only then the prose
charter, presented as the tool for open-ended coordination. Fix `org.ts` to
ship both Channel variants side by side (code and prose) — the contrast is
the tutorial, and it is also the direct answer to "have we gone too far":
the abstraction was one example and one missing helper away from looking
exactly right-sized.
