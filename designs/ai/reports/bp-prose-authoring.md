# Authoring term prose — how to write Processes, Agents, Tools, and Skills

The definitive study + guide for the term language's founding claim: **the
prose is the configuration**. Aligned to the canon —
[designs/ai/business-processes.md](../business-processes.md) (v4.1, "the
resting point"); where this guide and the canon disagree, the canon wins.
Companion to [bp-ddd-event-storming.md](./bp-ddd-event-storming.md)
(owns the DDD/ES research and the history of the rejected
entity/command/state excursion),
[bp-dx-open-source-org.md](./bp-dx-open-source-org.md)
(v3.1, owns the org catalog), and
[reassess-control-refs-v2.md](./reassess-control-refs-v2.md) (owns the render
doctrine). Vocabulary, per the canon's §2/§2a: what appears inside a
template is an **expression** — this guide's earlier "splice" coinage is
retired as mechanism-speak. The `AI.Entity`/`AI.command`/`AI.state`
vocabulary that earlier drafts of this guide covered was **removed by the
canon**; §4.6 now teaches the message declarations that replaced it
(`AI.when` in; the unmarked `${Event}` mention out — the mention IS the
publish grant, `AI.emit` is deleted). Mandated by the owner's review:

> "We're not doing a good job at demonstrating prose spliced with events,
> tools, budgets, references to other agents etc. All the examples are super
> basic, but this is really where our superpower is … **Every splice is an
> opportunity to integrate with prose, rather than just treating it as
> positional args with very little context.**"

## 0. Verdict up front

1. **The authoring rule is one sentence: write the paragraph a competent
   human colleague would need to do the job, then type the nouns.** The
   expression *is* the noun. A ref without a sentence around it is a noun
   without a verb — the model receives a name and no reason to reach for
   it, and the reader of the source receives a dependency list where a job
   description should be. Everything else in this guide is that rule
   specialized per render class and per term kind.

2. **The corpus already contains the masterclass — in three places — and
   ships the anti-pattern in the fourth.** The §1.7/§4.1 design-doc
   templates (`designs/ai/alchemy-ai-design.md:362-417, 871-943`), the test
   fixture org (`packages/alchemy/test/AI/fixtures/org/`), and bp-dx v3's
   Triage/RedSuite charters all demonstrate refs earning sentences. The
   *shipped example* (`examples/agent-chat-web/src/org.ts`) — the thing
   users actually copy — stacks its control refs at the tail with zero
   connective prose (`org.ts:149-151, 170-171`). §5 rewrites it.

3. **Every expression has a grammar, and it is knowable.** Each ref kind
   renders in exactly one way (`src/AI/Render.ts:9-26`;
   `reassess-control-refs-v2.md:205-218`), and for the prose-carrying refs,
   the author's template completes a specific kernel-owned frame sentence
   (`src/AI/KernelPrompts.ts`). Until-prose completes *"This run ends
   when: ___"*; check-prose arrives as *"Ring grading instructions: ___"*
   in the verifier's prompt; never-prose completes *"Health prose: ___"*.
   Write the clause that fits the frame (§2.2). Authors who don't know the
   frames write prose that renders as broken English — and two of the
   frames are **currently broken in the renderer itself** (§2.3: the
   input declaration's participial wrapper and a concurrency double-wrap),
   which this report files as framework fixes (§7).

4. **Inline refs weave; block refs stand.** Capability refs (tools, agents,
   processes, parameters, values), the message declarations (`AI.when` —
   declaration-only per the canon — and the unmarked `${Event}` mention,
   the publish grant, legal anywhere including nested in judgment prose),
   and the other inline
   control refs (concurrency, observe — `each`/`every` are deleted) render
   as noun phrases — they belong *inside* sentences, each with a grant +
   when + how. Block-rendering refs (until,
   never, budget) render kernel-worded sections — they belong on their own
   line at the position where a human SOP would state the rule ("done
   means…", "you have N attempts"), and the author's expressive
   opportunity is the judgment prose *nested inside* them, not narration
   dangling around them. bp-dx v2's charters weave block refs mid-sentence
   ("You are finished when ${AI.until(…)}, and ${AI.budget(…)} is all the
   time…", bp-dx **v2**'s Triage tail — repaired in v3) — admirable instinct, broken
   render (§5.3 fixes it). The planned lint (`reassess-control-refs-v2.md:109-110`)
   is right and should be extended (§7.1).

5. **Recipient scoping is a voice rule.** Check/fold prose renders
   into the *recipient's* prompt (`Render.ts:23-25`) — so write it in
   second person TO the judge, the scribe ("run ${Bash} yourself; the
   Engineer's claim is not a signal"), never in third person about the
   worker. The fixture Fix already does this correctly
   (`fixtures/org/processes.ts:49-52`).

6. **Prose never legislates what code enforces, and never restates what
   the kernel or the schema already says.** Guardrails that a Layer or a
   schema can enforce belong there (the deterministic coordinator needs no
   "never post as yourself" sentence — its code simply doesn't;
   `org.ts:100-141` vs `org.ts:145-151`). Constraints a Parameter's
   template carries must not be repeated in the tool body (§6.5). The
   halt/give-up protocol is kernel voice (`KernelPrompts.ts:41-46`) — the
   author who re-explains "call resolve when done" ships two competing
   protocols.

7. **Framework asks are small and listed in §7**: extend the block-ref
   lint; add a tail-stack lint; lint empty Parameter templates (don't make
   them a type error); fix the two inline-render bugs so inline refs render
   *nouns*, not canned phrases; keep the block-only `until` (the v2
   report's rejection of an inline form is upheld, with one refinement);
   and keep decentralized kernel prose consistent by **conformance-tested
   wording invariants**, not shared strings.

---

## 1. What was studied

### 1.1 The in-repo corpus

| Artifact | What it teaches | Grade as exemplar |
|---|---|---|
| `alchemy-ai-design.md:362-417` (§1.7: Engineer, Judge, Fix) | refs nested inside judgment prose — `${AI.until(PullRequestRef)}`'s template mentions `${pr}` *inside* the condition (`:401-402`); tools sequenced into procedure ("${Grep} before you ${ReadFile}", `:381-382`) | the founding masterclass |
| `alchemy-ai-design.md:871-943` (§4.1: Support, Triage, Reviewer, Scribe, Flywheel, Helpdesk, Autoresearch) | inline trigger narration ("${AI.on(…)} run ${Triage}", `:907`); escalation conditions in the same sentence as the grant (`:881-882`); nested `${Reply}` inside `AI.never` health prose (`:920-921`) | masterclass, with the trigger-grammar caveat of §2.3 |
| `test/AI/fixtures/org/{agents,processes,tools,vocabulary}.ts` | the same org, type-audited; check prose addressed to the Judge (`processes.ts:49-52`); tool templates with judgment ("duplicates are debt", `tools.ts:34-35`); Parameter templates as schema descriptions (`vocabulary.ts:22-24`) | strong; a few thin tools (`ReadFile`/`EditFile`, `tools.ts:21-25`) |
| `examples/agent-chat-web/src/org.ts` | the shipped tutorial — deliberately minimal | **the BEFORE material** (§5.1, §5.2): control refs as positional args (`:149-151, 170-171`), thin agent roles (`:39-45`) |
| `src/AI/Render.ts` + `src/AI/KernelPrompts.ts` | what each ref *actually* renders to; the three prose-ownership tiers (`KernelPrompts.ts:11-18`) | ground truth for §2 |
| `reassess-control-refs-v2.md` | the render-style doctrine: block refs own their line; inline refs weave; recipient refs are silent (`:200-218`); inline `until` rejected (`:117-124`) | doctrine, adopted |
| `bp-ddd-event-storming.md` (entity chapters) | the *judgement-prose-as-rule* voice (rules carry reasons; emissions live in cause-sentences) — the vocabulary it was written for (`AI.key`/`AI.state`/`AI.handles`) is **removed by the canon**, but the voice lessons transfer to §4.6's message prose | historical; voice doctrine survives |
| `bp-dx-open-source-org.md` v3.1 | the richest charters yet written (Triage §1.3, IssueWork/RedSuite §3.1); message declarations woven into prose (`AI.when` acceptance sentences, event mentions in cause-sentences); the Skill term + three example skills (§5) | exemplars, post-sweep |
| `reassess-proposal.md` §F | `AI.value(Tag)` for interpretation-time values; per-run data rides `In`/tool results, never the charter (`:242-246`) | the cache-discipline principle |

### 1.2 External guidance (2025–26), compressed to what transfers

- **Vercel Academy / TeensyCode** (`designs/ai/reports/vercel-academy.md`):
  the 5-section tool-description contract — summary+output format / WHEN TO
  USE / WHEN NOT TO USE / DO NOT USE FOR / USAGE / EXAMPLES
  (`vercel-academy.md:63`); **bash gravity** and the doubled negative
  ("Saying 'don't use this for searching' once isn't always enough. Saying
  it twice almost always is", `:64`), with model-tier sensitivity (Haiku
  ignores WHEN NOT under ambiguity; Sonnet benefits from the DO-NOT
  reinforcement; Opus handles both); the **truncation contract** (cap /
  announce / paginate — "a tool that silently truncates is worse than no
  truncation at all", `:58`); the **ambiguity protocol** (search → ask →
  act, `:138`); the **verification-honesty contract** (scoped claims;
  "hedged future tense is the tell" for confabulated verification,
  `:146-150`); prompt structure role → Agency → Guardrails → Verification
  with explicit negatives (`:154`); and — already mapped to us — "our
  Parameter templates *can* carry those constraints in the schema
  description, closing the gap that forces their USAGE section to exist"
  (`:242`, insight 21).
- **Anthropic Agent Skills authoring** (agentskills spec + skill-creator,
  fetched July 2026): the `description` is *the* triggering mechanism —
  ≤1024 chars, carrying **what AND when**, written slightly "pushy"
  ("Claude tends to *undertrigger* skills — include all contexts where the
  skill would be useful"), with trigger keywords and **negative triggers**;
  body <500 lines, imperative, *explains why not just what*; three-level
  progressive disclosure (metadata always resident ≈100 words; body on
  trigger; resources on demand).
- **Anthropic tool guidance** (platform docs + Building Effective Agents
  appendix 2): "3–4 sentences minimum per tool description"; be
  prescriptive about *when* to call, not just what it does ("on recent
  Opus models, trigger conditions in the description give measurable lift
  in should-call rate"); "think of it as a docstring for a junior developer
  on your team"; poka-yoke the parameters (absolute paths over relative
  fixed SWE-bench tool misuse outright); 1–5 realistic examples only where
  correct usage isn't obvious from the schema.
- **Prompt lore from the harness studies**: pi's ~300-token system prompt
  whose skills index carries only name+description+path with "use the read
  tool to load a skill's file when the task matches its description"
  (`pi.md:69-71`) — the index-is-stable / body-rides-a-tool-result cache
  discipline our Skill design adopts (`bp-dx-open-source-org.md` §5.3).
  Codex's goal-loop exit prompts: the continuation template demands a
  requirement-by-requirement completion audit — "The audit must prove
  completion, not merely fail to find obvious remaining work" — and a
  blocked audit only after the same blocker repeats ≥3 consecutive turns
  (`codex.md:52`); "the most operationally mature loop-exit criteria I've
  seen shipped" (`codex.md:145`). Mastra's Observer prompt opens by telling
  the fold agent what its output *is for* ("Your observations will be the
  ONLY information the assistant has about past interactions",
  `mastra.md:82`) — the model for our fold-prose voice.

Where external advice conflicts with our mechanics, our renderer wins and
the conflict is noted in place: e.g. Anthropic's "put trigger conditions in
the tool description" is *strengthened* here because our tool prose renders
into the schema section once and is prompt-cache-stable
(`alchemy-ai-design.md:356`), and Vercel's USAGE section partially
dissolves into Parameter templates (§4.1).

### 1.3 Who owns which prose — the three tiers, after KernelPrompts decentralizes

`KernelPrompts.ts:11-18` names the tiers, and the owner has ruled the shared
module is going away (each kernel owns its connective prose directly). The
tier boundaries survive the module's deletion — they are the authoring
contract, not an implementation detail:

1. **Charter prose — the author's.** Everything inside a term's template:
   role, procedure, judgment, guardrails, the nested templates of
   until/check/fold. This guide is about tier 1.
2. **Ring instructions — per-wiring.** The templates handed to
   `AI.check(Judge)`…`` / `AI.fold(Scribe)`…`` at a *specific* expression
   site. Also the author's, but addressed to the recipient (§2.2).
3. **Kernel connective tissue — the harness's.** The halt contract's
   resolve/give_up protocol (`KernelPrompts.ts:41-46`), the boundary nag
   (`:100-103`), the verifier framing with maker/checker stated as law
   ("the worker's claim of done-ness is not a signal; verify
   independently", `:124-125`), the budget consequence ("Exceeding any of
   these ends the run as a budget failure — work efficiently", `:76-78`),
   synthetic tool descriptions (`give_up`: "Call ONLY when you have
   concrete evidence … `reason` must state the blocker and the evidence",
   `:145-147`).

The wording lessons of tier 3 that authors must internalize (because your
prose is *quoted inside* it): the kernel speaks the **protocol** (which
tool to call, what happens on breach) and speaks it in second person with
evidence demands; the author supplies the **judgment content** the
protocol quotes. Never restate protocol in tier 1 — "call resolve when
every criterion is met" in a charter is a second, drifting copy of
`KernelPrompts.ts:43-46`. What the decentralization changes is *who
guarantees tier 3's consistency across kernels* — §7.6 recommends
conformance-tested wording invariants.

---

## 2. The grammar of the expression

This is the section the corpus never wrote down. A tagged-template author is
writing into a typed macro system where every interpolation has exactly one
render behavior. Knowing the render class tells you where the ref can sit;
knowing the frame sentence tells you what voice its nested prose must take.

### 2.1 The three render classes (plus two placeholders)

From `Render.ts:9-26` and the doctrine table
(`reassess-control-refs-v2.md:205-218`):

| Class | Refs | Renders as | Authoring consequence |
|---|---|---|---|
| **Inline noun** | `${Tool}`, `${Agent}`, `${Process}`, `${Skill}` (per bp-dx §5), `${Event}` (an unmarked EventSource mention — the publish grant, a leaf expression like a Tool ref, legal anywhere in the template including nested inside judgment prose), `${AI.observe(P)}`, `${AI.concurrency(n)}`, `${AI.when(X)}` (declaration-only per the canon; the legacy `each`/`every` forms are deleted) | a name / numeral / short phrase, in place (`Render.ts:59-60, 85-101, 104`) | must sit inside a sentence; the sentence carries grant + when + how — for `AI.when`, *how to interpret the accepted message*; for an event mention, *when publication happens* (the sentence carries the verb) |
| **Block paragraph** | `${AI.until(…)}`, `${AI.never…}`, `${AI.budget(…)}` | a kernel-worded section with a heading, at the author's position (`Render.ts:68-84`; `KernelPrompts.ts:37-79`) | own line, at the SOP position; never mid-sentence; the author's prose goes *inside* the nested template |
| **Recipient-scoped, host-silent** | `AI.check(A)`…``, `AI.fold(A)`…`` | `""` in the host prompt; the template renders into the verifier's / fold agent's prompt (`Render.ts:23-25, 102-105`) | write TO the recipient, second person; the host's need-to-know is already kernel-supplied (the `verified` line) |
| **Typed placeholder** | `${Parameter}` | `{name}` (`Render.ts:57-58`) | a noun the model fills; its *own* template is the schema description — constraints live there, once |
| **Interpretation-time value** | `${AI.value(Tag)}` | the service-resolved string; `{key}` hole in previews (`Render.ts:61-67`) | a noun for values known at interpretation time (org name, policy text); never per-run data (`reassess-proposal.md:242-246`) |

Mention-vs-grant, stated once — this is the canon's governing rule: **an
unmarked reference to a term grants its affordance** (`${Tool}` → may
call, `${Agent}`/`${Process}` → may consult/dispatch, `${Event}` → may
publish). Interpolating a ref is what joins its tag to
`Req` (`fixtures/org/agents.ts:2-4`), and `Req` is a *set* — mentioning
`${issue}` or `${Bash}` three times grants nothing extra and costs nothing
but the rendered name. **Mention freely wherever the sentence needs the
noun.** The fixture Engineer mentions `${ReadFile}` twice in one breath
("${Grep} before you ${ReadFile}; ${ReadFile} before you ${EditFile}",
`fixtures/org/agents.ts:43-44`) precisely because the *procedure* needs it
twice. Mention-anxiety — writing "the file tool" on second reference to
avoid an expression — produces prose that names a capability the renderer
can't keep in sync. The inverse discipline is the real one: an unmarked
expression is a *grant*, so don't drop `${Approve}` into a rhetorical
flourish ("you don't get to ${Approve}") — say "you do not merge"
(`fixtures/org/agents.ts:48`) and let the *absence* of the ref be the fence
(`alchemy-ai-design.md:417`, `fixtures/org/processes.ts:105-108`). A truly
inert mention is written as plain text or `${X.name}` — every term exposes
`name`, and interpolating the string grants nothing.

Two owner-sensitivity refinements (canon §2/§2a, the domain-prose
round): a **world-owned catalog event** (`GitHub.IssueOpened` — only
the world can publish it) affords nothing, so its bare mention renders
as vocabulary and grants nothing; inbound use is always `AI.when` /
`AI.until`. And an **Alchemy Resource is itself a legal expression**
(`"monitor the ${alchemy} repository"`): it renders its resolved
identity at interpretation time and contributes a dependency edge —
never a capability; acting on the resource still requires a Tool or
Skill that closes over it.

### 2.2 The frame sentences — what your nested prose completes

Every prose-carrying control ref's template is inserted into a kernel frame.
Write the clause that fits the frame:

| Ref | The frame (current memory-kernel wording) | Your clause's voice | Exemplar |
|---|---|---|---|
| `AI.until(S)`…`` | "This run ends when: **___**" then the resolve/give_up protocol (`KernelPrompts.ts:41-46`) | present-tense condition about the *world*, nesting the refs the condition inspects; no leading "when", no protocol restatement | "every acceptance criterion is checked and the run resolves with the ${pr} the Engineer opened" (`alchemy-ai-design.md:401-402`) |
| `AI.exit(AI.when(source, …))`…`` (machine-observed) | "This run ends when {source description(s)} — **___**" (the world settles the run; no resolve tool; variadic `when` ⇒ multi-source exits) | the *consequence/context* clause completing the sources' own descriptions — never a naked exit block, and NEVER a correlation callback (the event family's `key` correlates exits to runs; an explicit `match` is a rare override, and restating "which run" in prose or code is the routing anti-pattern) | "${AI.exit(AI.when(GitHub.IssueClosed(repo)))`whether the merged pull request closed it or a maintainer closed it by hand`}" |
| `AI.budget` | — no longer an expression: a ceiling is the caller's operational setting, provided as a Layer at composition (`Layer.provide(AI.budget({…}))`), never written in a charter | — | — |
| `AI.never`…`` | "This is a perpetual ring… Health prose: **___**" (`KernelPrompts.ts:53-55`) | name the observable substitutes for an exit and their cadence | "no exit; merge rate, time-to-first-response, and reopen rate are folded weekly and posted via ${Reply} to #maintainers" (`alchemy-ai-design.md:920-921`) |
| `AI.check(Judge)`…`` | verifier prompt: "…maker/checker applies… Ring grading instructions: **___**" (`KernelPrompts.ts:117-135`) | imperative, second person TO the judge; name the evidence the judge must gather itself | "grade each iteration against the issue's criteria: run ${Bash} yourself — the Engineer's claim of done-ness is not a signal" (`fixtures/org/processes.ts:49-52`) |
| `AI.fold(Scribe)`…`` | the fold agent's prompt | imperative TO the scribe; say what the distillate is *for* (Mastra's Observer move, `mastra.md:82`) | "distill lessons into .alchemy/NOTES.md after every iteration, successful or not" (`fixtures/org/processes.ts:54-55`) |
| `AI.budget({…})` | no prose slot — the kernel words the allowance and the consequence (`KernelPrompts.ts:58-79`) | placement is the entire authoring decision: put it where a human SOP states the allowance | tail of Fix, after the exit contract (`fixtures/org/processes.ts:57`) |

The message declarations carry no kernel frame — they are inline nouns
(§2.1) — but they have their own sentence obligations:

| Ref | What it declares | Your sentence's job | Exemplar |
|---|---|---|---|
| `${AI.when(X)}` | "I accept broadcast message X as input" — a **pure declaration**: types `In`, renders, appears in topology. It wires **nothing**; delivery is always outside code (the front door `send`s/`steer`s) | **continue the sentence the expression started** — the expression renders as a complete clause ("when {X.description}": *"when an issue opens in alchemy-run/test-alchemy"*), so your prose composes with it: what one delivery means for run scope ("one issue, one run"), what the sender already guaranteed, what to do first. NEVER restate the event ("`${AI.when(IssueOpened(repo))}` an issue opens, …" says it twice) | "${AI.when(GitHub.IssueOpened(repo))} and the case opens with it: run ${Triage} first" |
| `${E}` (an unmarked event mention) | "I may publish message E" — the mention IS the grant: joins the `emits` topology, permits typed `ctx.emit(E, …)`, contributes the source's channel tag to `Req`; renders as the event's name | a **cause-sentence**: the sentence carries the verb ("publish", "announce") and states *when* the emission happens and what its downstream meaning is; the expression is legal anywhere in the template, including nested inside judgment prose ("When X and Y, publish ${Z} with …") | "Publish the finding as ${CulpritIdentified} the moment you have it — the dashboards correlate red-main minutes from that event" (`bp-dx-open-source-org.md` §3.1.5) |

**The charter is a process document, not a state machine in text.**
Write it like the runbook you'd hand a new maintainer: plain flowing
prose that happens to reference events, agents, and tools where the
sentence naturally needs them. Framework vocabulary — "case", "run",
"ring", "door", "steer", "admission" — must NEVER appear in
model-facing prose; those are engine words, and the model doesn't
operate the engine, it does the job. If a paragraph reads like routing
logic ("then pick the door…"), delete it: routing is the front door's
code, not the charter's concern. And keep the roster honest — **the
Process does work too**: it can search, reply, decide, and merge with
its own tools; an Agent exists only where the work is a distinct craft
with a distinct toolbox (writing the fix; judging it), not one per
step of the flow. A Triage agent whose job the process could do in two
sentences is roster bloat that turns prose into a dispatch table.

**Use the tool as the sentence's verb.** A tool mention renders as its
name, and a well-named tool reads as the action itself — so write
"`${SearchIssues}` for duplicates", "`${Reply}` asking the reporter to
close it", "Once approved, `${MergePullRequest}`". The instrumental
form — "search … with `${SearchIssues}`", "reply with `${Reply}`",
"merge it with `${MergePullRequest}`" — says the action twice (the
same failure as "publish `${AI.emit(X)}`" was). This is also a
NAMING obligation on the tool author: pick names that work as verbs
(and ideally double as the noun) — `comment`, not `postMessage`;
`approve`, not `requestApproval` — so every charter that hires the
tool can compose it into a sentence.

**Expressions render as combinators — the term owns its clause.** An
`EventSource` carries a `description` phrase set by whoever defines it
(the catalog constructor `GitHub.IssueOpened(repo)` renders *"an issue
opens in alchemy-run/test-alchemy"*; your org-internal source should
set its own), and the marked expressions compose it: `AI.when(X)` →
"when {description}", `AI.until(X, match)` → the exit clause. This is
the division of labor: the *term author* writes the clause once, every
*charter author* composes sentences with it. A source without a
description falls back to its name — legible, but write the
description. The renderer never emits a fragment the charter must
complete; if you find yourself finishing an expression's sentence for
it, the term is missing its description.

Never list event mentions in a bare "Events:" block squeezed at the
charter's tail — the emission's *when* and its downstream meaning are
the content, and a bare list is the positional-arg anti-pattern (§6.2)
wearing a domain hat. And because the unmarked mention is a grant, a
truly inert reference — prose that merely talks *about* an event — is
written as plain text or `${X.name}`, which interpolates the string and
declares nothing.

Two writing consequences fall out:

- **Until-prose is a *condition*, not an instruction.** "the issue is
  labeled, deduped, and either marked ready or bounced" fits the frame;
  "label the issue and then resolve" does not — it's procedure, which
  belongs in the charter body, and it collides with the kernel's own
  "call the resolve tool" instruction.
- **Check-prose that describes the worker is mis-addressed.** "The Engineer
  must have run the tests" reads as a fact about a third party; "run
  ${Bash} yourself — the Engineer's claim of done-ness is not a signal"
  arms the actual reader. The verifier frame already establishes
  maker/checker; your clause's job is the *specific* grading procedure and
  evidence standard.

### 2.3 Two places the renderer currently breaks the grammar (found during this study)

These are framework bugs this report surfaces; they matter here because
they change what authors can safely write *today*, and §7 files the fixes.

**(a) The inline input declaration renders a participial phrase, not a
noun.** `Render.ts:87-101` delegates to `kernelPrompts.triggerNote`
(`KernelPrompts.ts:85-97`), which renders the `on` form → "woken by
⟨sources⟩", `each` → "serving a queue of ⟨param⟩", `every` → "on a
schedule (⟨expr⟩)" (the latter two forms are now deleted from the
surface).
But the control-refs v2 doctrine specified the inline render as the bare
source label — "`${AI.on(IssueOpened)} run ${Triage}` → 'on
`github.issues.opened/o/r` run Triage'"
(`reassess-control-refs-v2.md:117-120`, and the §5 table: "source names /
`{param}` / the expression, inline", `:214`). The implementation drifted,
and the drift breaks the canonical charters as rendered:

- Flywheel's "${AI.on(IssueOpened…)} run ${Triage}"
  (`fixtures/org/processes.ts:66-67`) renders "woken by
  github.issue.opened… run Triage" — passable.
- bp-dx **v2**'s Triage opened "When ${AI.on(GitHub.IssueOpened(repo))}
  delivers one", which renders "When woken by github.issue.opened
  delivers one" — **broken English in the model's system prompt.**
  (v3.1 fixed the charter to "${AI.when(…)} a new issue lands, it is
  your run", which reads as the declaration it now is.)
- Fix's "${AI.each(issue)} give ${Engineer} a completely fresh context"
  (`fixtures/org/processes.ts:41`) renders "serving a queue of {issue}
  give Engineer…" — a run-on. (`AI.each`/`AI.every` are deleted outright
  by the canon — dispatch and platform cron replace them — so this
  exhibit is legacy-fixture evidence for the render law, not a form to
  author.)

Until the renderer is fixed (§7.3), authors must treat the declaration
expression as the phrase it renders to. The render fix has two extra
reasons now: `AI.when` is a **pure input declaration** (no auto-delivery
— the canon deleted the trigger runtime), so "woken by X" teaches the
model a wiring that no longer exists; and the rename to `when` exists
precisely so the expression can read as the sentence's own conjunction
— "${AI.when(X)} a member posts, …" — which a participle spoils. That
conjunction voice — "${AI.when(X)} ⟨what happened⟩, ⟨what one delivery
means⟩" — is the target; under the current renderer's participle, a
lead-in phrasing ("You accept ${AI.when(X)} — …") remains grammatical.

**(b) Concurrency double-wraps.** The v2 doctrine says
`${AI.concurrency(3)}` renders the bare numeral so authors write the
sentence ("at most ${AI.concurrency(3)} in flight" → "at most 3 in
flight", `reassess-control-refs-v2.md:87, 218`). The implementation
renders `kernelPrompts.concurrencyNote(n)` = "at most 3 in flight"
(`Render.ts:85-86`; `KernelPrompts.ts:82`) — so the canonical Flywheel
charter (`fixtures/org/processes.ts:70`) renders **"at most at most 3 in
flight in flight."** The doctrine and the fixture are right; the renderer
arm is wrong (§7.3).

The general law both bugs violate, worth stating as the conformance rule
for every kernel's renderer: **inline refs render nouns; only block refs
may render kernel wording.** The moment an inline ref renders a canned
phrase, the author can no longer write a grammatical sentence around it —
which destroys precisely the "every expression is an opportunity" property
the owner is asking us to demonstrate.

---

## 3. Principles

Numbered so the playbooks and lints can cite them.

**P1 — Write the sentence first; type the nouns.** Draft the charter as the
paragraph you would hand a competent new colleague, with the tool/agent
names inline where a human would name them; then make each name an
expression.
If a name has no natural place in your paragraph, question the grant —
either the capability is unnecessary or your paragraph is missing the step
that uses it. The test-fixture Support agent is the model: four numbered
steps, seven grants, every one inside the step that uses it
(`fixtures/org/agents.ts:21-33`).

**P2 — Every ref earns a sentence: grant + when + how.** The minimum
freight for a capability expression is *when to reach for it* and *what good
use looks like*: "${SearchIssues} for duplicates and workarounds **first**"
(`agents.ts:25`); "${AskHuman} **for anything touching secrets, state
corruption, or billing** — never speculate publicly about those"
(`agents.ts:30-31`); "activate ${BisectSkill} **and let git do the
finding**" (`bp-dx-open-source-org.md` §3.1.5). A bare `${Tool}` at the
template's tail is a positional arg — the exact thing the owner rejected.
This mirrors Anthropic's should-call finding (trigger conditions in the
description measurably lift correct tool selection) applied at the *host*
side of the seam: the tool's own contract says when in general; the
charter's sentence says when *for this role*. Vercel's deliberate
redundancy ("we're saying it in two places because models miss it in one",
`vercel-academy.md:154, 238`) blesses the duplication.

**P3 — Judgment prose nests refs.** The templates inside
until/check/fold accept interpolations, which both render real names
and join `Req` (`reassess-control-refs-v2.md:162-166`) — and an event
mention is itself a leaf expression that nests inside any judgment
prose. Use that: an
exit condition that inspects the world should name the instrument —
`AI.until(…)`every acceptance criterion is checked and the run resolves
with the ${pr} the Engineer opened`` (`alchemy-ai-design.md:401-402`);
a grading instruction should name the evidence tool — "run ${Bash}
yourself" (`fixtures/org/processes.ts:50`); a publication rule should
name the event where the rule lives — "When the culprit is known and
reproduced, publish ${CulpritIdentified} with the SHA and the
failing test". A plain-string condition mentioning "bash" is dead
text: no Req contribution, and a tool rename strands it — the drift
the framework exists to kill.

**P4 — Block refs sit where a human would state the rule; inline refs sit
where the noun goes.** The `until` goes on its own line at the point in
the SOP where "done means…" belongs — usually the tail, but RedSuite's
"the suite going green is your only discharge" earns a lead-in sentence
right before it (§5.4). The `budget` goes where the allowance would be
stated ("you have N attempts"). Never continue a sentence *after* a block
ref: the block ends with kernel protocol text, and your ", and…" dangles
off the end of a paragraph you didn't write (§6.3).

**P5 — Address the recipient.** Check/fold prose renders to
someone else. Second person, imperative, to *them*; include what their
output is for (the Mastra Observer lesson: the fold agent that knows its
notes are "the ONLY information the assistant has" writes better notes,
`mastra.md:82`). Prose about the worker written into a check template is
the most common scoping error (§6.4).

**P6 — Prose never legislates what code enforces.** The Vercel todo tool
enforces single-active-item in `execute`, "one rule the agent can't argue
with" (`vercel-academy.md:144`); our equivalent is the Layer and the type
system. A charter line like "you never merge" is legitimate *behavioral*
prose for an AI-direct term — but the load-bearing fence is the absent
`${Approve}` (`alchemy-ai-design.md:417`). And when a term is
deterministic, guardrail prose written for a model coordinator is dead
weight: the shipped Support charter says "never a participant"
(`org.ts:145-146`) because its coordinator is a model; the deterministic
Engineering coordinator needs no such sentence because `ctx.post` is only
ever called with member names (`org.ts:131-138`). Write guardrails for the
executor that actually reads them.

**P7 — Don't duplicate the schema; don't duplicate the kernel.** Parameter
templates ARE the schema descriptions (`vocabulary.ts:2-5`) — a tool body
that re-explains the `path` format is a second copy that will drift
(§6.5). The kernel owns the halt protocol, the verification notice, the
budget consequence (§1.3) — charters restating them ship competing
protocol copies.

**P8 — Cache discipline: the charter is the stable prefix.** Per-run data
(the user's message, the issue body, retrieved docs) rides `In` and tool
results — never the template. Values known at interpretation time but not
authoring time (org name, an escalation-criteria document) enter via
`${AI.value(Tag)}` (`reassess-proposal.md:242-246`; `Render.ts:61-67`),
which stamps the prompt hash per interpretation while keeping the charter
static per deployment. If you feel the urge to template-in something that
changes per run, you are about to break `promptHash`, provider prompt
caching, *and* replay — put it in the work item and let domain-owned
formatting present it (`org.ts:66-73`).

**P9 — Length is a budget; Skills are the overflow.** Always-resident
charter prose competes with the work for attention (pi keeps its default
system prompt near 300 tokens and pushes everything else behind the skills
index, `pi.md:69-71`). Know-how that is real but rarely needed — a bisect
procedure, a release checklist, a migration playbook — belongs in a Skill
whose one-line description stays resident and whose body loads on
activation (`bp-dx-open-source-org.md` §5.3). The charter keeps the
*decision* ("if the failure does not name its author, activate
${BisectSkill}"); the Skill keeps the *procedure* (§4.5).

**P10 — Demand proven completion in exit-adjacent prose.** Codex's goal
loop is the operational high-water mark: completion "must be proven, not
merely fail to find obvious remaining work," and "blocked" requires the
same blocker ≥3 consecutive turns (`codex.md:52`). Our kernel's `give_up`
already demands evidence (`KernelPrompts.ts:145-147`); the author-side
counterpart is until/check prose that names *mechanically checkable*
conditions ("labeled, deduped, and either marked ready with criteria or
bounced with a question") and verification-honesty guardrails in agent
prose ("Never say 'should work'" — already in Support,
`agents.ts:33`; the fuller scoped-claims form is in §4.2's exemplar).

---

## 4. The per-term playbook

Each subsection: a skeleton, then a fully-worked exemplar, then the notes
that differ from the generic principles.

### 4.1 Tool

The 5-section contract (`vercel-academy.md:63`) adapts to tagged templates
with two structural changes: **USAGE mostly dissolves into Parameter
templates** (constraints live on the schema, once — `vercel-academy.md:242`
predicted exactly this), and the first line doubles as the one-line summary
a future renderer/skills-index may surface (`alchemy-ai-design.md:356`).

Skeleton:

```
`⟨One sentence: verb + ${params} + what comes back (output format).⟩

⟨WHEN TO USE: 2–4 trigger scenarios, prescriptive — "use it to/when…".
 Include the judgment that makes use good: cost notes, ordering advice.⟩

⟨WHEN NOT / DO NOT: name the alternative tool with a real `${Tool}`
 expression; for tools in a
 gravity well (anything bash-shaped), double the negative.⟩

⟨OUTPUT/TRUNCATION: announce caps, what's kept (head/tail), and the
 recovery move (narrower invocation, pagination param).⟩`
```

Worked exemplar — `Bash` upgraded from the two-line fixture version
(`fixtures/org/tools.ts:27-29`):

```ts
const command = AI.Parameter("command", S.String)`
A single shell command line, run with bash -c at the repository root
of the sandboxed DevBox. Quote paths containing spaces. Chain
dependent steps with && in one call rather than issuing them as
separate calls.`;

export class Bash extends AI.Tool<Bash>()("bash")`
Run ${command} in the sandboxed DevBox; returns stdout, stderr, and
the exit code.

Use it to run the test suite, the type-checker, builds, and git —
anything whose OUTPUT is the evidence you need. The test suite is the
only oracle of done-ness: a claim without a green run is not a claim.

Do not use it to search or read the repository — ${Grep} searches and
${ReadFile} reads, cheaper and paginated. Do NOT run grep, find, cat,
or ls through bash: the unbounded output floods your context and the
dedicated tools exist precisely to prevent that.

Output over 5,000 characters is truncated keeping the TAIL (test
failures and build errors live at the end); the truncation notice
states how much was cut. Recover by narrowing — a single test file, a
summary reporter — never by re-running the same firehose.` {}
```

Why each piece sits where it does: the `${command}` expression renders
`{command}` in the description and its Parameter template becomes the
JSON-schema description (`alchemy-ai-design.md:355`) — so the quoting/
chaining constraints are written once, on the parameter, and the tool body
never repeats them (P7). The doubled negative ("Do not use it to search…
Do NOT run grep…") is the bash-gravity counterforce, model-tier-verified
(`vercel-academy.md:64`); naming `${Grep}`/`${ReadFile}` makes the
redirect a rendered cross-reference **and** documents the intended
toolbox — though note the wrinkle in §8 (a tool template's refs join the
*host's* Req; a redirect mention is a real grant, which here is almost
always what you want since any bash-holder should hold grep/read too).
The truncation paragraph is the Vercel contract, third clause included:
cap, announce, and the recovery move (`vercel-academy.md:58`).

When to write EXAMPLES: only where correct usage isn't obvious from the
schema (Anthropic's rule) — for `Bash` the Parameter carries it; for a
tool with a format-sensitive body (a JQL query, a cron expression), one or
two realistic invocations in the template earn their tokens.

### 4.2 Agent

Skeleton (the Vercel prompt structure — role / agency / guardrails /
verification / escalation — compressed into charter form):

```
`⟨Role line: who you are, in one sentence that also scopes the input:
 "You receive exactly one ${issue}…".⟩

⟨Procedure: numbered steps with tools woven in AT their step, ordering
 stated as doctrine ("${Grep} before you ${ReadFile}").⟩

⟨Guardrails: explicit negatives, each with its reason.⟩

⟨Verification honesty: scoped claims; name-the-command; the
 hedged-future-tense ban.⟩

⟨Escalation: ${AskHuman} with its trigger conditions in the same
 sentence.⟩`
```

Worked exemplar — `Engineer` upgraded from
`fixtures/org/agents.ts:41-48`, folding in the ambiguity protocol and the
verification-honesty contract (`vercel-academy.md:138, 146-150`):

```ts
export class Engineer extends AI.Agent<Engineer>()("Engineer")`
You are the implementing engineer. You receive exactly one ${issue}
whose acceptance criteria are your entire specification — if a
criterion admits two readings, gather context first, then ${AskHuman}
with both readings; never pick one silently.

Work in this order:
1. ${Grep} for every symbol the issue names before you read anything —
   search is cheap, reading spends context.
2. ${ReadFile} only what you will change or must understand to change
   it. Do not read files "just in case".
3. ${EditFile} the smallest diff that satisfies the criteria — no
   drive-by cleanup, no speculative abstraction.
4. ${Bash} runs the tests after EVERY edit; all green is the only
   definition of done you may use.

Report what you verified, not what you hope: name the exact command
you ran and its result, and distinguish failures you caused from
failures that pre-date your change. If you did not run it, say so —
"should work" is not in your vocabulary.

When green, ${OpenPullRequest} citing the issue and the per-criterion
evidence. You do not review your own work, and you do not merge.` {}
```

Annotations: the role line types the input in prose ("exactly one
${issue}") — same fact the channels derive, stated where the model reads
it. `${AskHuman}` carries its trigger *and* its protocol position (gather
context → ask with concrete options → act) in one sentence — the search→
ask→act ordering matters because agents otherwise ask too early or too
late (`vercel-academy.md:138`). Steps 1–2 are the fast-context policy
("grep first, read only what you'll change" turned a 30-step crawl into 5,
`vercel-academy.md:145`) — note it's *agent* policy here, complementing
(not repeating) Grep's own "cheap — always search before you read"
(`tools.ts:18-19`). The verification paragraph is the scoped-claims
contract nearly verbatim — it is prompt-borne honesty, the "hardest gate"
(`vercel-academy.md:150`). The closing negatives keep their reasons
attached; the missing `${Approve}` expression is the real merge fence.

### 4.3 Process charter (AI-direct)

Skeleton:

```
`⟨Mandate: why this process exists, one or two sentences — the sentence
 that makes every later judgment call decidable.⟩

⟨Acceptance declaration woven inline, the expression as the sentence's
 own conjunction: "${AI.when(Source)} ⟨what happened⟩, ⟨what one
 delivery means: run scope, what the front door already guaranteed,
 what to do first⟩." Remember: AI.when declares, it does not
 wire — delivery is the front door's code — and the surrounding prose
 is where the model learns how to interpret the message. (Under the
 current renderer, mind the participial render, §2.3a.)⟩

⟨Delegation: who you hand work to and WHEN, per delegate, with the
 selection criterion in the sentence: "${Sage} for depth, ${Scout} for
 speed — both when it is urgent AND deep".⟩

⟨World-visible acts: each ${Tool} with its triggering condition and
 its evidence/format obligations. Published messages the same way:
 each event mention ${E} inside the cause-sentence that carries the
 verb and states when it is published and what downstream reads it —
 never a bare list at the tail.⟩

⟨Exit lead-in sentence (optional, ends with a period), then:
 ${AI.until(Schema | Source)`…condition, refs nested…`}   ← own line
 ${AI.budget({ … })}                                       ← own line⟩`
```

The worked exemplar is the RedSuite rewrite (§5.4) — it exercises every
row: pager-mandate, machine exit with a lead-in, skill activation with its
trigger, delegation with a decision rule, budget as tolerated-outage
prose. One structural note beyond the principles: **a charter's delegation
sentences are the org chart** — "${Sage} for depth (architecture, code,
trade-offs), ${Scout} for speed (quick takes), BOTH when it is urgent and
deep. Never empty." (`org.ts:88-92`) is simultaneously routing doctrine
for the model and the topology a human audits. Write the criterion, not
just the roster.

### 4.4 Deterministic processes — where does prose live when the handler is code?

`AI.process(Term, ctor)` renders to no model (`bp-dx-open-source-org.md`
§1.3), so the term's charter is *spec, not instructions* — it documents
what the code must do and keeps the one-line Layer swap open
(`bp-dx-open-source-org.md` §1.3). The prose that actually reaches
models lives in three places:

1. **The classifier leaves.** The one place a deterministic coordinator
   consults an LLM is a typed leaf agent, and its template does real work:
   `Classify` states the output contract ("Reply with ONLY a JSON object
   …"), the routing criteria per member, and the never-empty guardrail —
   in five lines (`org.ts:88-92`). Leaf templates follow the Agent
   playbook compressed: role + criteria + output format + one guardrail.
2. **The tool contracts.** Code calls tools too, but the same tool tags
   are usually shared with AI-direct terms — their prose must stand alone
   (§4.1) regardless of which caller is deterministic today.
3. **The term's residual charter.** Keep it honest and minimal: the
   Engineering channel's two-line charter (`org.ts:96-98`) is acceptable
   *because* nothing reads it at runtime — but even a spec-charter
   benefits from one mandate sentence, since the moment someone swaps the
   Layer to `AI.layer(Engineering)` the charter IS the implementation.
   Rule of thumb: **write every charter as if it might be interpreted** —
   that is the standing option the term system sells
   (`bp-dx-open-source-org.md` §1.3) — but spend the richness budget on
   the leaves and tools that models read today. The honest edge (prose/
   code drift on deterministic implementations) is real and documented
   (`bp-ddd-event-storming.md:1100-1107`); the charter-as-generation-source
   mitigation only works if the charter is written to instruction quality.

### 4.5 Skill

Skeleton (per the bp-dx term design — first paragraph is the always-resident
index entry, body loads on activation, `bp-dx-open-source-org.md`
§5.1/§5.3 — and the Anthropic description discipline):

```
`⟨INDEX PARAGRAPH, ≤1024 chars: what this skill does AND when to
 activate it. Slightly pushy — list every trigger context, including
 the tell-tale situation ("whenever you catch yourself doing X by
 hand"). Include negative triggers ("not for…") if misuse is likely.⟩

⟨BODY: numbered procedure, imperative, with ${Tool} expressions at their
 step; the WHY on any step that looks skippable; a deactivation cue —
 what "done with this skill" means.⟩`
```

Worked exemplar — `BisectSkill` upgraded from
`bp-dx-open-source-org.md` §5.2:

```ts
export class BisectSkill extends AI.Skill<BisectSkill>()("bisect")`
Find the commit that broke main by binary search. Activate when a
check-suite failure does not name its culprit commit, when a
regression's first-bad-commit is unknown, or whenever you catch
yourself reading commit diffs one by one to locate a break. Not for
flaky tests — a bisect over a nondeterministic failure converges on
noise; first prove the failure reproduces twice in a row.

Playbook:
1. Fix the endpoints: the failing SHA from the check-suite payload is
   bad; the last green run on main is good.
2. ${Bash} \`git bisect start <bad> <good>\`, then drive every step
   with the NARROWEST failing command — \`bun vitest run <suite>\`
   scoped to the failing test, never the full suite (each bisect step
   multiplies your test cost by log2(commits)).
3. Wrap every run in \`timeout 240\`; a hang IS a failure signal —
   mark the commit bad and continue.
4. End with \`git bisect reset\` no matter the outcome — a repo left
   mid-bisect breaks whoever works next.
5. Report the culprit SHA and the first failing test, then deactivate:
   the finding is this skill's discharge, not the fix.` {}
```

Annotations: the index paragraph carries three positive triggers — the
event-shaped one, the state-shaped one, and the *behavioral tell*
("whenever you catch yourself…"), which is the "pushy" style Anthropic's
skill-creator recommends because models undertrigger — plus one negative
trigger with its reason (flake → noise). The body explains why on the two
steps a model would otherwise skip (narrow command: cost multiplication;
reset: the next worker). The deactivation cue draws the skill's own exit
boundary, which matters because deactivation is a capability toggle, not
memory management (`bp-dx-open-source-org.md` §5.3). And the host
side keeps its half of the contract: the *charter* sentence that
references the skill states the activation condition ("if the failure does
not name its author, activate ${BisectSkill} and let git do the finding",
`bp-dx-open-source-org.md` §5.3) — description says when in general,
charter says when for this role, the same two-place redundancy as tools
(P2).

### 4.6 Messages — declaring inputs and outputs in prose

Earlier drafts of this guide taught an "Entity" playbook here
(`AI.key`/`AI.state`/`AI.handles`/`AI.emits` expressions). **The canon
removed that vocabulary** (the run is the instance; durable state is
your DB or a fold over the Trace; denial happens at the front door).
What a charter declares about the message world is now exactly two
inline expressions — `${AI.when(X)}` (accepted inputs) and the unmarked
`${E}` mention (published outputs — the mention IS the publish grant)
— and the authoring craft is the prose around
them. The skeleton:

```
`⟨Acceptance sentence around ${AI.when(X)}, the expression as the
 sentence's own conjunction: what one delivery MEANS —
 run scope ("one new issue is one run"), what the sender already
 guaranteed ("the front door hands it to you already validated"),
 how later messages relate ("comments from the reporter arrive as
 messages into this same run"). AI.when declares; it never wires —
 do not write prose that promises delivery mechanics.⟩

⟨One cause-sentence per event mention ${E}: the sentence carries the
 verb ("publish", "announce"), states WHEN the emission happens, in
 present tense with its reason attached, and what downstream meaning
 it has ("…the dashboards correlate red-main minutes from that
 event"). The mention may sit anywhere — including nested inside
 until/check judgment prose ("When X and Y, publish ${Z}
 with …").⟩`
```

The moves worth naming as doctrine (the voice lessons carried over
from the entity excursion — the vocabulary died, the writing rules
did not):

- **Acceptance deserves a sentence, not a line.** A naked
  `${AI.when(X)}` at the tail is the positional-arg anti-pattern (§6.2).
  The sentence around the declaration is where the model learns run
  scope and message meaning: "${AI.when(IssueLabeled(repo, 'ready'))}
  an issue is readied, the case is yours — one readied issue is one
  run" states the actor contract
  exactly where a colleague would state it.
- **Judgement prose is a *rule*, and rules carry reasons.** "anything
  labeled security or breaking waits for a human — no matter how small
  it looks" — the reason is what lets an AI-direct executor generalize
  to the case you didn't enumerate, and what makes the prose a
  reviewable spec when the Layer is deterministic.
- **Emissions live in cause-sentences.** "Announce a dispatch as
  ${FixDispatched}; announce a deferral, with its queue position and
  reason, as ${FixDeferred}" — the sentence carries the verb, and the
  cause-observation pairing
  the org example established (`org.ts:187-196`) survives. Never list
  event mentions in a bare "Events:" block; the emission's *when* and its
  downstream meaning are the content.
- **The world's state is disclaimed, not modeled.** Where an external
  system owns the state machine, the charter says so out loud — "it is
  GitHub that closes it, not your claim that you are done" — and the
  exit is the machine-observed `AI.until(source, match)`. The
  disclaimer is doctrine (you cannot reject reality, only record it),
  and its presence in the charter is what stops a future maintainer
  from teaching the model to trust its own cache.

---

## 5. BEFORE / AFTER

Four real terms rewritten to exemplar standard. Each AFTER is paste-ready;
expression-level annotations follow each. (The AFTERs are written against the
*fixed* renderer of §7.3 where noted; the one place current render
mechanics force a phrasing is flagged.)

### 5.1 `Support` — the shipped prose coordinator (`examples/agent-chat-web/src/org.ts:145-151`)

BEFORE:

```ts
export class Support extends AI.Process<Support>()("support")`
You are the #support channel coordinator — never a participant. Relay
${Helper}'s reply with ${PostReply} (author "Helper"), then resolve.
Escalate engineering-shaped problems by saying so in your resolution.
${AI.on(PostOpened)}
${AI.until(S.String)`the user's question is answered or escalated`}
${AI.budget({ iterations: 6 })}` {}
```

What's wrong: the input declaration is a positional arg — a naked
`${AI.on(…)}` line
carrying no sentence (the exact pattern the owner rejected); "Relay
${Helper}'s reply" grants two capabilities in one clause without saying
when Helper is consulted or what fidelity the relay owes; "engineering-
shaped" is undefined, so the escalation judgment has no criterion; the
until prose ("answered or escalated") doesn't tell the model what evidence
distinguishes the two.

AFTER:

```ts
export class Support extends AI.Process<Support>()("support")`
You coordinate the #support channel. ${AI.when(PostOpened)} a member
starts a thread, you own it until it is resolved or escalated.

You are a relay, never a participant: ${Helper} reads the thread and
drafts every reply — give Helper the full thread, not your summary of
it. Post exactly what Helper returns via ${PostReply} with author
"Helper", verbatim; if the reply would be wrong to post, go back to
Helper with your objection rather than editing it yourself.

A question about our code, architecture, or a suspected bug is
engineering-shaped: do not let Helper guess at it. Resolve with an
escalation note that names what the user needs and why support cannot
answer it — the #engineering channel picks up from your resolution.

${AI.until(S.String)`the user's question is answered — Helper's reply
is posted in the thread — or the resolution names the escalation and
its reason`}
${AI.budget({ iterations: 6 })}` {}
```

Expression annotations:

- `${AI.when(PostOpened)} a member starts a thread, you own it…` — the
  acceptance declaration moves *into* the mandate sentence, and the
  expression reads as the sentence's own conjunction (the fixed render,
  §7.3, keeps it so: "when workspace.post.opened a member starts a
  thread…"; under today's participial render it degrades to "woken by
  workspace.post.opened a member starts a thread", §2.3a). The sentence
  also states run scope (one Post = one run), which was previously only
  derivable from the kernel. Remember what the expression *is*: a pure
  declaration of the accepted message — the front door's code creates
  the run and steers the follow-ups; nothing here wires delivery.
- `${Helper}` — two sentences now govern the delegation: what Helper gets
  (the full thread — an input-fidelity rule) and what happens on
  disagreement (return with an objection, don't edit — a fidelity rule for
  the *output*). Both were silent before; both are decisions the model
  otherwise makes ad hoc per run.
- `${PostReply}` — the grant now carries its constraint (author "Helper",
  verbatim) in the sentence that uses it, replacing the parenthetical.
- The escalation paragraph defines "engineering-shaped" by extension
  (code, architecture, suspected bug) and gives the resolution a format
  obligation (name what the user needs + why) — the until prose can then
  reference "names the escalation and its reason" and be mechanically
  checkable against the resolution text.
- The two block refs stand on their own lines at the tail (P4). The until
  clause completes "This run ends when: …" with observable conditions
  (posted reply / named escalation), not intentions.
- The "never a participant" guardrail survives — this term is AI-direct,
  so the sentence has a reader (P6).

### 5.2 `Issues` — the machine-exit goal (`examples/agent-chat-web/src/org.ts:165-171`)

BEFORE:

```ts
export class Issues extends AI.Process<Issues>()("issues")`
Work the issue described in the Post. If the Post explicitly says the
fix is already verified/applied, close it immediately with ${CloseIssue}
using its issue number. Otherwise investigate with ${Sage}, and close it
with ${CloseIssue} only when genuinely resolved.
${AI.on(PostOpened)}
${AI.until(IssueClosed)}` {}
```

What's wrong: better than Support (the tools have conditions), but the two
control refs are stacked positionally; the charter never says what the
machine exit *means* for the model's behavior — that a human closing the
issue also settles the run, and that closing is caused-then-observed, not
claimed (the whole point of this example, per its own header comment
`org.ts:163-164`, currently lives in a code comment the model never sees);
"investigate with ${Sage}" gives Sage no input contract; and there is no
budget at all on an AI-direct run.

AFTER:

```ts
export class Issues extends AI.Process<Issues>()("issues")`
${AI.when(PostOpened)} a Post opens, you own the issue it describes
until the world records it closed.

Read the Post first. If it explicitly states the fix is already
verified and applied, close immediately with ${CloseIssue}, citing the
issue number from the Post — settled work needs no re-investigation.
Otherwise hand the investigation to ${Sage}: one focused question per
dispatch, always with the Post's full text, and act on the concrete
recommendation Sage ends with.

Close with ${CloseIssue} only when the fix is genuinely in place —
closing is an act the world audits, not a way to end your run. A
maintainer may also close the issue out from under you; that counts.

${AI.until(IssueClosed)}
${AI.budget({ iterations: 8, wallClock: "30m" })}` {}
```

Expression annotations:

- The mandate sentence puts the reconciler doctrine *in the prompt*:
  "until the world records it closed" tells the model its resolve
  condition is an observation, and "a maintainer may also close… that
  counts" names the human path — previously only a source-code comment
  (`org.ts:163-164`). Machine exits deserve a sentence explaining their
  machine-ness; the `${AI.until(IssueClosed)}` block then renders the
  formal contract at the tail.
- `${CloseIssue}` appears twice (P: mention freely) — once for the
  fast-path with its precondition ("explicitly states… verified and
  applied") and evidence source ("the issue number from the Post"), once
  with the honesty guardrail ("an act the world audits, not a way to end
  your run" — the cause-vs-claim doctrine, `org.ts:187-189`, now
  model-visible).
- `${Sage}` gets an input contract (full text, one question per dispatch)
  and an output expectation (Sage's charter ends with "a concrete
  recommendation", `org.ts:35-37` — the delegation sentence points at it).
- A budget appears: every AI-direct goal run needs a stated allowance
  (P4); eight iterations for an investigate-and-close loop matches the
  Triage/RedSuite calibration norms.

### 5.3 `Triage` — bp-dx v2's worked example (historical BEFORE; bp-dx v3 has since adopted this repair)

BEFORE (the relevant tail; the body is genuinely good):

```
…Whatever you decide, say it on the issue itself (${CommentOnIssue}) —
silence reads as neglect. You are finished when ${AI.until(TriageVerdict)`the
issue is labeled, deduped, and either marked ready with criteria or bounced
with a question`}, and ${AI.budget({ iterations: 4, wallClock: "10m" })} is
all the time first contact is worth.
```

Honest assessment: this charter is the corpus's best *body* — every
capability expression sits inside a sentence with its reason ("duplicates are
debt, and the reporter deserves the original thread, not a fork"), and it
was written expressly to demonstrate the owner's principle
(bp-dx §1.3's framing survives into v3). But its v2 tail wove **block** refs
into a running sentence, and the render breaks it twice over: "You are
finished when" is followed by a `# Halt condition` heading mid-sentence,
and ", and" continues after the halt block's protocol paragraph, leading
into a `# Budget` heading followed by "is all the time first contact is
worth" dangling after *that* block (§2.3, `Render.ts:68-84`). It also
opens with "When ${AI.on(GitHub.IssueOpened(repo))} delivers one" — which
renders "When woken by github.issue.opened delivers one" (§2.3a).

AFTER:

```ts
export class Triage extends AI.Process<Triage>()("Triage")`
Every new issue deserves a first response in minutes, not days.
${AI.when(GitHub.IssueOpened(repo))} a new issue lands, look for its
siblings
before anything else (${SearchIssues} — duplicates are debt, and the
reporter deserves the original thread, not a fork). A genuine new
issue gets labels and acceptance criteria precise enough that a
${Fix} run could verify them mechanically; an unclear one gets
bounced back with exactly one question — two questions is an
interrogation, zero is a guess. Whatever you decide, say it on the
issue itself (${CommentOnIssue}) — silence reads as neglect — and
publish the verdict as ${IssueTriaged} so the rest of the
org can act on it.

First contact is deliberately cheap; do not research what you can
bounce as the one question.

${AI.until(TriageVerdict)`the issue is labeled, deduped, and either
marked ready with criteria or bounced with exactly one question`}
${AI.budget({ iterations: 4, wallClock: "10m" })}` {}
```

Expression annotations:

- The acceptance clause exploits the `when` rename: "${AI.when(…)} a
  new issue lands, look for…" is written so the expression is the
  sentence's own conjunction — the fixed render (§7.3, "when
  github.issue.opened a new issue lands, …") keeps it grammatical, and
  today's participial render ("woken by github.issue.opened a new issue
  lands…") degrades but survives. Author rule: make the acceptance
  expression the sentence's opening conjunction with the event clause
  right after it — or lead with "You accept ${AI.when(…)} — …" where
  the charter needs a mandate sentence first. Either way the
  surrounding
  prose, not the expression, explains how to interpret the message.
- The block refs move to their own lines (P4). Everything the woven
  version tried to say survives: "You are finished when" is now the
  kernel's own "This run ends when:" (saying it twice was the bug, not
  the sentiment); "all the time first contact is worth" becomes the
  budget's lead-in sentence, ending with a period *before* the blocks so
  nothing dangles.
- One judgment upgraded while here: "exactly one question" gains its
  reason ("two is an interrogation, zero is a guess") and the until prose
  repeats *exactly one* so the verifier can count.
- The unmarked `${IssueTriaged}` mention rides the decide-and-say
  sentence, which carries the verb ("publish") — the
  publication is declared exactly where its cause is stated (§4.6), not
  appended as an "Events:" list.

### 5.4 `RedSuite` — bp-dx v2's pager process (historical BEFORE; bp-dx v3 has since adopted this repair)

BEFORE (tail):

```
…Tell #maintainers (${Reply}) what broke and what you did — the suite going
green is your only discharge:
${AI.until(GitHub.CheckSuitePassed(repo, { branch: "main" }))}, and
${AI.budget({ iterations: 8, wallClock: "2h" })} is how long the org
tolerates a red main before a human takes over.
```

Honest assessment: again a strong body (the pager-not-ticket mandate; the
revert-vs-fix decision rule with its power analysis "a revert needs
nobody's permission"; `${BisectSkill}` activated with its condition). Same
tail disease: ", and" after a halt block; budget block mid-sentence with
its rationale stranded after the render. One body gap: the two `${Reply}`
obligations (culprit found; road chosen) are compressed into one vague
"what broke and what you did".

AFTER:

```ts
export class RedSuite extends AI.Process<RedSuite>()("RedSuite")`
${AI.when(GitHub.CheckSuiteFailed(repo, { branch: "main" }))} main
goes red, every open PR is rebasing onto a broken base. Treat the
failure as a pager, not a ticket: acknowledge fast, diagnose second,
fix third.

Find the breaking commit first. If the failing check names its commit,
trust it; if not, activate ${BisectSkill} and let git do the finding —
do not eyeball diffs when a binary search is available. Publish the
finding as ${CulpritIdentified} the moment you have it — the
dashboards correlate red-main minutes with authors and subsystems
from that event.

Then take the cheapest road back to green, and the default is revert:
open it with ${OpenPullRequest} — a revert needs nobody's permission
and no design review. Dispatch ${Fix} instead only when the forward
fix is plainly smaller than the revert, and hand it your reproduction
as its only acceptance criterion. Never force-push — history is how
the next responder finds what you did.

Tell #maintainers (${Reply}) twice: once when you know the culprit,
once when the road back is chosen. Silence during a red main is
worse than a wrong guess stated out loud.

Your PR merging is not the discharge; your message is not the
discharge. The suite going green is.

${AI.until(GitHub.CheckSuitePassed(repo, { branch: "main" }))}
${AI.budget({ iterations: 8, wallClock: "2h" })}` {}
```

Expression annotations:

- The machine exit gets the strongest lead-in in the corpus — three
  negations then the condition — because this is the term where a model
  most wants to claim victory at PR-open. The lead-in ends with a period;
  the block follows on its own line; the kernel's contract does the
  formal work. (The budget's rationale — "how long the org tolerates a
  red main" — was good prose in a bad position; it is now implied by the
  pager framing, and the block states the numbers. If a kernel's
  budgetNote wording ever supports it, this is the one place an
  author-supplied budget rationale clause would earn its keep — noted in
  §7.4.)
- `${BisectSkill}` keeps its activation condition and gains the
  anti-pattern it replaces ("do not eyeball diffs") — a skill reference
  should name what NOT doing it looks like, since that's the behavior the
  model will otherwise default to.
- `${Fix}` dispatch carries its input contract ("your reproduction as its
  only acceptance criterion") — a delegation without an input contract is
  a positional arg with extra steps.
- `${Reply}` becomes a countable obligation (twice, with the two
  moments named), and gains its reason (silence-vs-wrong-guess) — the
  same move as Triage's "silence reads as neglect".
- The unmarked `${CulpritIdentified}` mention sits in the sentence that
  carries the verb ("publish") and states its
  moment ("the moment you have it") and its consumer (the dashboards)
  — the cause-sentence rule of §4.6, nested naturally in the diagnosis
  paragraph rather than listed at the tail.

---

## 6. Anti-patterns

Each named, exhibited from the corpus, with the repair rule.

**6.1 Ref-stacking at the tail.** Trailing `${Tool}` or declaration refs
with no interstitial prose — the charter ends in a dependency manifest.
Exhibit: `org.ts:149-151` (three control refs, zero sentences);
`org.ts:97-98`. Repair: P1/P2 — inline refs move into the sentences that
use them; block refs may stack at the tail *only* because their render
carries kernel sentences (a stack of two block refs is fine; a stack of
one `AI.when` + two blocks is not, because the declaration renders
inline).

**6.2 Expressions as positional args.** The general form of 6.1: any ref
whose surrounding text would read identically if the ref were deleted.
`"Relay ${Helper}'s reply"` is borderline; `"${AI.when(PostOpened)}"` alone
on a line is the pure form. Test: read the rendered prompt aloud; every
rendered name should be governed by a verb and modified by a condition.

**6.3 Orphaned block refs mid-sentence.** Text continuing after a block
ref on the same line or sentence ("…${AI.until(…)}, and ${AI.budget(…)} is
all the time…", bp-dx **v2**'s Triage/RedSuite tails — repaired in v3). The block
render ends with kernel protocol text; your continuation dangles off a
paragraph you didn't write. Repair: lead-in sentence ends with a period;
block ref on its own line; nothing after it on the line. The planned lint
(`reassess-control-refs-v2.md:109-110, 228`) catches the mid-sentence
case; §7.1 extends it to trailing same-line text.

**6.4 Check/fold prose about the worker instead of to the judge.** "The
Engineer must have run the tests before resolving" describes; "run
${Bash} yourself — the Engineer's claim of done-ness is not a signal"
instructs the actual reader (`fixtures/org/processes.ts:49-52` is the
correct form). The tell: third-person references to the worker as
subject, or imperative verbs whose implied subject is the worker. Repair:
P5 — second person, to the recipient, with the recipient's evidence
procedure.

**6.5 Prose duplicating schema constraints.** A tool body restating what
its Parameter template already carries ("path must be repo-relative" in
both places), or an until template restating its schema's shape ("resolve
with a JSON object containing…" — the kernel already says "with the
result value" and bounces mismatches, `KernelPrompts.ts:43-44, 181-182`).
One constraint, one home: format on the Parameter, protocol on the
kernel, judgment in the charter (P7). Drift between two copies is worse
than either copy alone — the model can't tell which is authoritative.

**6.6 Over-long always-on prose that should be a Skill.** A charter or
agent template carrying a rarely-used procedure inline (a full release
checklist inside ReleaseBlogger; bisect mechanics inside RedSuite). Cost:
resident tokens on every run, attention dilution (pi's ~300-token
discipline exists for a reason, `pi.md:69`), and prompt-cache churn every
time the procedure is tuned. Repair: P9 — the charter keeps the
activation decision; the Skill keeps the procedure
(`bp-dx-open-source-org.md` §5.3).

**6.7 Kernel-voice duplication.** Charter prose re-explaining resolve/
give_up, re-warning about the budget consequence, or re-announcing that
resolutions are verified. All three are kernel-supplied
(`KernelPrompts.ts:41-51, 76-78`); the author's copy competes and drifts.
Repair: P7. The one legitimate neighbor is a *lead-in* that motivates the
contract without restating it ("The suite going green is your only
discharge", §5.4).

**6.8 Guardrails addressed to nobody.** Model-facing guardrail prose on a
term whose Layer is deterministic ("never post as yourself" on a code
coordinator), or — the inverse — invariants left to prose that the Layer
could enforce (a "one task at a time" rule stated in prose while the
handler could serialize). Repair: P6 — prose for the executor that reads
it; code/Layers/types for invariants; and when a term is
deliberately Layer-flexible, write the guardrail but know it is
load-bearing only under `AI.layer`.

---

## 7. Framework implications

Each recommendation small, independently adoptable.

**7.1 Extend the block-ref lint (adopt; trivial).** The planned lint flags
a block-rendering ref interpolated mid-sentence
(`reassess-control-refs-v2.md:109-110, 228`). Extend it to also flag (a)
non-whitespace text after a block ref before the newline, and (b) a
sentence continuing on the next line whose first token is a conjunction
(", and…" after a block line — the §5.3/5.4 disease is specifically the
trailing continuation, not just the mid-sentence expression).

**7.2 Add a tail-stack lint (adopt; heuristic, warn-only).** Warn when a
template's trailing ≥2 *inline-rendering* refs (capability refs, `AI.when`
declarations, event mentions)
have fewer than ~15 non-whitespace characters of interstitial prose
between/around them. This mechanically catches `org.ts:149-151` and
`org.ts:97-98` while leaving legitimate block-ref tails (Fix's
until/check/fold/budget stack, `fixtures/org/processes.ts:46-57`)
untouched, since check/fold render recipient-scoped and until/budget are
block class. Do **not** lint bare-`${Tool}`-without-a-sentence in general:
"Verdict via ${Approve} or changes via ${Reply}"
(`fixtures/org/agents.ts:53`) is terse *and* correct, and any
sentence-quality heuristic beyond the tail-stack case will false-positive
constantly. House style and review carry the rest.

**7.3 Fix the two inline-render bugs (adopt; ~10 LOC).** Per §2.3:
`Concurrency` renders the bare numeral (delete the `concurrencyNote`
wrapper; the v2 spec already says so, `reassess-control-refs-v2.md:87,
218` — today the canonical Flywheel fixture renders "at most at most 3 in
flight in flight"). The `AI.when` declaration renders the minimal
phrase — "when ⟨sources⟩", so the expression reads as the sentence's own
conjunction — not the "woken by…" participle (the v2 spec's noun-phrase
rule, `:117-120`, carried through the §2a rename; the `each`/`every`
render arms go away with their constructors). Conformance rule
to carry into the decentralized-kernel world: **inline refs render nouns
(or minimal prepositional phrases); only block refs render kernel
sentences.** Snapshot-test each kernel's renderer against the fixture org
and *read the output aloud* — the broken-English renders survived because
nothing forced a human to read the rendered prompt.

**7.4 Keep `until` block-only (uphold the v2 rejection), with one
refinement.** The v2 report rejects an inline `until` clause because the
resolve/give_up protocol must render somewhere and two render forms make
byte-stable rendering position-fragile (`reassess-control-refs-v2.md:117-124`).
This study confirms the rejection from the authoring side: every case
where an author *wanted* an inline until (Triage, RedSuite) is better
served by a lead-in sentence + block (§5.3, §5.4) — the desire was for
narrative flow into the contract, not for a different contract shape. The
refinement: kernels should word their halt-contract and budget blocks to
*compose with a lead-in* — heading first, no assumption that the block
opens a topic cold — and the one authored clause genuinely lost today is
a budget rationale ("…is how long the org tolerates a red main"). If any
kernel wants it, the right shape is an optional prose template on budget
(`AI.budget({…})`rationale``) rendered inside the kernel's block — NOT an
inline render form. File as a nice-to-have; §5.4 shows the workaround is
adequate.

**7.5 Parameter templates: lint-require, don't type-require.** A
Parameter's template is the schema description
(`alchemy-ai-design.md:355`; `vocabulary.ts:2-5`); an empty one ships a
schema hole the model fills by guessing — the SWE-bench path-mistake class
Anthropic fixed with parameter-level constraints. But making prose
mandatory at the constructor repeats the rejected `RequireHalt` mistake
(construction should stay total; `alchemy-ai-design.md:341`). Recommend: a
kernel lint at interpretation time — warn on any reachable Tool whose
Parameter has an empty/whitespace template, error under a strict flag.
Same treatment for Tool templates under ~2 sentences (bash gravity is
empirical and tier-dependent — a nudge, not an error;
`vercel-academy.md:242`). Also adopt the deferred `param.as`override``
(`alchemy-ai-design.md:360`) when it lands, so shared parameters can carry
per-use descriptions instead of tempting authors into body-prose
duplication (§6.5).

**7.6 Decentralized kernel prose: conformance-tested wording invariants.**
With `KernelPrompts.ts` dissolving into each kernel, the risk is dev and
prod kernels teaching subtly different protocols (the module's own
docstring named this hazard, `KernelPrompts.ts:16-18`). Recommend the
middle road between byte-identical strings and per-kernel freedom: the
Phase-2 conformance suite asserts **semantic invariants over rendered
output**, not bytes — the halt contract names both `resolve` and
`give_up` and quotes the author's clause verbatim; the budget block
states every configured ceiling and the consequence; the verifier prompt
states independence ("the worker's claim is not a signal" in some
wording) and quotes the check template verbatim; give_up's description
demands evidence; blocked/denied tool calls produce a model-visible
result (the confabulation trap, `vercel-academy.md:40-42`). Each kernel
additionally keeps golden snapshots of its own renders (byte-stable
per-kernel for promptHash), and the fixture org is the shared test
corpus. The author-facing frames of §2.2 become *documented contract*:
kernels may reword the frame, but the slot's grammatical class (a
condition clause; second-person instructions) is normative — that is
what keeps this guide's advice kernel-portable.

**7.7 Render the tool one-liner (small, high leverage).** `${Tool}` in a
charter renders the bare name today (`Render.ts:59-60`); the design
allows name "plus (configurable) a one-line summary"
(`alchemy-ai-design.md:356`). With tool templates now front-loading a
summary sentence (§4.1 skeleton), rendering `name` in prose but
`name — first sentence` in the tool-schema section (where it already
goes) is enough; do NOT inline summaries into charter prose — it bloats
every mention (P: mention freely) and double-renders against the schema
section. The first-sentence convention should be documented so authors
write tool openings that survive extraction — same discipline as Skill
index paragraphs.

---

## 8. Honesty notes

- **The AFTER rewrites are untested against live models.** They follow
  empirically-sourced guidance (Vercel's tier-tested doubled negatives,
  Anthropic's should-call data, the corpus's own conventions), but no
  A/B run behind them exists. The flywheel (Autoresearch,
  `fixtures/org/processes.ts:110-123`) is the designed mechanism for
  validating charter prose against traces; these rewrites are its seed
  hypotheses, not its output.
- **The §2.3 render bugs were verified by reading `Render.ts` and
  `KernelPrompts.ts` against the fixtures — not by executing the
  renderer.** The double-wrap ("at most at most 3 in flight in flight")
  is derived from `Render.ts:85-86` + `KernelPrompts.ts:82` +
  `fixtures/org/processes.ts:70`; a golden test should confirm before the
  §7.3 fix is applied. (This report ran no builds or tests per its
  constraints.)
- **The Skill and message playbooks target designs, not landed code.**
  `AI.Skill` is bp-dx gap 10 (§5), and the event-mention publish grant +
  typed `ctx.emit` are the canon's P0 in flight; spellings could shift
  in implementation and the playbooks should be revised with them.
  (The former `AI.Entity` playbook is gone with its design — the canon
  removed the entity/command/state vocabulary outright; §4.6 now
  teaches the message declarations that replaced it.)
- **Tool-template refs and Req: asserted from the design's nesting rule,
  not traced through `Services.ts` for the Tool case specifically.** §4.1
  assumes `${Grep}` inside Bash's template joins the host's Req at
  depth-1 like other nested templates (`Services.ts` per
  `reassess-control-refs-v2.md:62-63`); if Tool templates turn out not to
  contribute nested tags, the redirect-mention advice stands (it renders
  the name) but the "real grant" caveat falls away. Worth a type test.
- **≤1024-char and ≤500-line Skill numbers are Anthropic's spec limits**
  (agentskills.io / skill-creator, fetched July 2026), adopted here as
  house norms because our Skill design deliberately mirrors that shape
  (`bp-dx-open-source-org.md:1228-1230`); our term system imposes no such
  limits mechanically.
- **One deliberate scope cut:** this guide does not restate the
  perpetual-vs-goal doctrine, run identity, or exit-source mechanics —
  it assumes them (reassess-proposal §B, exit-conditions) and only
  governs the *prose* those mechanics quote. Where a charter's prose
  problem turned out to be a mechanics problem (Triage's woven until),
  the fix respected the mechanics rather than proposing new ones.
