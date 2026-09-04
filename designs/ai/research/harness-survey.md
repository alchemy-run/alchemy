# Harness Survey: What Shipped Agent Loops Actually Do (2024–2026)

This is the PRACTICE report in the nine-agent research fan-out. It surveys shipped harnesses — coding agents, agent SDKs, ambient/long-running systems — and maps their empirical convergence against alchemy's charter/stance/kernel model (`packages/alchemy/src/AI/Kernel.ts`, `KernelMemory.ts`, `Actor.ts`, `Run.ts`, `Skill.ts`; exemplars `services/alchemy-org/src/issues.ts`, `engineer.ts`).

---

## 1. The landscape: loop shapes actually shipped

The field has converged, with remarkable unanimity, on one loop. Anthropic's own definition ("agents are LLMs autonomously using tools in a loop") is now the literal architecture of every shipped harness:

```
while (true):
  response = model(system + transcript, tools)
  append response to transcript
  if no tool calls: break / park
  execute tools, append results
```

**Claude Code** is this loop plus a large *static* system prompt, CLAUDE.md memory files naively prepended, a permission layer that gates each tool call, hooks (deterministic shell interception points around tool use, prompt submit, compaction), subagents (Task tool → fresh context, restricted tool subset, returns one summary message), skills (three-tier progressive disclosure, see §3), a TodoWrite tool that externalizes plan state into a list the harness re-renders, and compaction when the window fills. **OpenAI Codex CLI** is the same loop in Rust with an app-server protocol; its distinguishing feature is a first-class `turn/steer` RPC (see below). **Cursor** (this harness) is the same loop plus queued user messages, subagent fan-out, and todo externalization. **Aider** predates the convention and is more workflow-shaped: repo-map for context, tight edit-format contracts, and a two-model `architect/editor` mode — plan/execute as *two different models with two different prompts*, the earliest shipped evidence that "mode = different stance" works. **OpenCode** and **Amp** are Claude-Code-shaped (Amp adds threads, handoffs to fresh threads, and an "oracle" reasoning subagent).

Two structural facts matter for alchemy:

1. **Nobody ships a graph as the primary abstraction for the *inner* loop.** LangGraph is the exception that proves the rule: it makes the state machine explicit (nodes, edges, a typed state channel), but its own prebuilt `create_react_agent` — what people actually deploy — is a two-node graph (`agent → tools → agent`) i.e. the same while-loop. The graph machinery earns its keep at the *workflow* level (checkpointing, human-in-the-loop interrupts, subgraphs), not inside the sampling loop.
2. **Modes are real and shipped everywhere, but implemented shallowly.** Claude Code plan mode, Aider architect mode, OpenAI Agents SDK handoffs, Cursor plan/agent modes — every serious harness has stance switching. None of them re-derive the stance declaratively; all mutate imperatively (see §4).

**Termination**: every harness stops on "no tool calls" (alchemy's `quiescent = response.toolCalls.length === 0` is exactly the industry test), usually with a step-count/cost circuit breaker on top (Vercel defaults to 20 steps; Anthropic's research system embeds effort-scaling rules in the prompt). Alchemy's kernel currently has **no step budget** — every shipped system learned to add one.

**Steering**: the empirical split is precise and recent. Codex exposes `turn/steer` — queued user input is delivered *at the next model boundary* of the running turn, batched, without aborting in-flight work; Esc escalates to interrupt. Claude Code has **no** mid-turn steer primitive: stream-json input mid-turn is dropped; the UI queues messages until the turn completes; the only programmatic option is interrupt+resubmit (partial work stays in history). Community tooling (OpenClaw, hapi) built steering queues on top of both, and Codex's own TUI had to fix races by *always queueing while a stream is active*. The convergent design — queue, promote at the sampling boundary, never abort in-flight tool calls — **is exactly alchemy's `steer`** ("the pi/codex discipline" comment in `KernelMemory.ts` is accurate). This one is validated; keep it.

**Perpetual/ambient agents**: OpenAI background mode runs the same loop server-side with polling/webhooks; LangGraph "ambient agents" are cron- or event-triggered graph runs over a persistent thread with interrupt points for human approval; Devin is a session-based agent with persistent *knowledge* (auto-suggested, user-confirmed memory snippets) and *playbooks* (reusable procedure prompts ≈ skills). None of them keep one live transcript running for weeks. **Every shipped "perpetual" agent is actually a relay of bounded episodes over durable external state.** Anthropic's long-running-harness post (Nov 2025) makes this explicit: an initializer agent writes `feature_list.json`, `claude-progress.txt`, `init.sh`, an initial git commit; every subsequent session is a *fresh context* that reads git log + progress, does one increment, tests, commits, updates the log, and exits clean. They found **context reset with handoff artifacts beats compaction** for long tasks. Letta/MemGPT is the other pole: keep the agent "alive" but make memory self-editing (§3).

---

## 2. Primary sources

Read in full during this survey:

- **Manus, "Context Engineering for AI Agents: Lessons from Building Manus"** (Yichao Ji, Jul 2025) — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus. Read fully. KV-cache discipline, mask-don't-remove, filesystem-as-context, recitation, keep-errors-in, don't-few-shot-yourself.
- **Anthropic, "How we built our multi-agent research system"** (Jun 2025) — https://www.anthropic.com/engineering/multi-agent-research-system. Read fully. Orchestrator-worker, token economics (multi-agent ≈ 15× chat tokens), synchronous-subagent bottleneck, checkpoint/resume in production, appendix on filesystem artifacts to avoid the game of telephone.
- **Anthropic, "Effective context engineering for AI agents"** (Sep 2025) — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents. Read fully. Attention budget/context rot, just-in-time retrieval, compaction (tool-result clearing as the safest form), structured note-taking, sub-agent condensation.
- **Anthropic, "Effective harnesses for long-running agents"** (Nov 2025) — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents. Read via secondary excerpts + summaries. Initializer/coding agent relay, progress files, git as recovery substrate, context reset > compaction.
- **Cognition, "Don't Build Multi-Agents"** (Walden Yan, Jun 2025) + follow-up **"Multi-Agents: What's Actually Working"** — https://cognition.ai/blog/dont-build-multi-agents, https://cognition.ai/blog/multi-agents-working. Direct fetch timed out; read via extensive quoted excerpts (jxnl.co interview writeup, agentic-ai.readthedocs.io analysis). Principles: share full traces, actions carry implicit decisions; 2025 update: "writes stay single-threaded; additional agents contribute intelligence, not actions" — read-only subagents are fine and are basically tool calls.
- **Vercel AI SDK, Loop Control (`prepareStep`/`stopWhen`)** — https://ai-sdk.dev/docs/agents/loop-control. Read fully. The only shipped API that re-computes model/tools/system/messages per step.
- **LangGraph persistence docs** — https://docs.langchain.com/oss/python/langgraph/persistence. Read fully. Checkpointer (thread-scoped state snapshots at superstep boundaries) vs Store (cross-thread KV); interrupts resume from checkpoints; known failure mode: unbounded checkpoint growth.
- **MemGPT paper** (arXiv 2310.08560) + Letta docs — https://arxiv.org/abs/2310.08560, https://docs.letta.com. Read paper excerpts + current Letta SDK docs. Two-tier memory (main context = system + working context + FIFO queue; external = recall + archival), self-directed memory editing via tools, recursive-summary eviction, heartbeats; Letta V2 now ships MemFS (git-tracked memory) + skills + subagents — converging on the Claude-Code shape.
- **Claude Code internals**: plan mode deep-dives — https://github.com/Windy3f3f3f3f/how-claude-code-works (docs/10-plan-mode.md), https://y-agent.github.io/inside-claude-code/19-plan-mode.html — read fully. Skills docs — https://code.claude.com/docs/en/skills, https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview — read fully.
- **Codex steering**: openai/codex PR #12569 and issue #17095; hapi issue #888 (empirical comparison of Codex `turn/steer` vs Claude Code's absence of one); OpenClaw queue-steering docs. Read fully.
- **OpenAI Agents SDK**: handoffs docs + reference — https://openai.github.io/openai-agents-python/handoffs/, https://developers.openai.com/api/docs/guides/agents/orchestration. Read fully.

Consulted from working knowledge (not re-fetched): Anthropic "Building effective agents" (Dec 2024; workflows vs agents taxonomy), Aider architect mode docs, Devin docs (knowledge, playbooks, planning), OpenAI background mode announcement, Effect `@effect/ai` (`LanguageModel`/`Toolkit` — provider abstraction only, deliberately loop-agnostic; alchemy's kernel builds on it directly).

---

## 3. Context-management state of the art

**KV-cache discipline is the load-bearing economics.** Manus: cache hit rate is "the single most important metric for a production agent"; input:output ratio ≈ 100:1; cached tokens are ~10× cheaper (Claude: $0.30 vs $3.00/MTok). The rules: byte-stable prompt prefix (no timestamps), append-only context, deterministic serialization, explicit cache breakpoints where the API needs them. Alchemy's frozen head + append-only `<situation>` messages is precisely this discipline — arguably cleaner than most harnesses, which let the system prompt drift.

**Mask, don't remove** (Manus). Tool definitions serialize near the front of the context, *before* the transcript. Adding or removing a tool mid-run therefore (a) invalidates the KV cache for the entire transcript after the tools block and (b) confuses the model when earlier turns reference tools that no longer exist, causing schema violations and hallucinated calls. Manus instead keeps the tool list **fixed for the whole run** and constrains selection per step with response-prefill/logit masking, using name prefixes (`browser_*`, `shell_*`) so whole groups can be enforced without stateful logit processors. This is the single sharpest empirical challenge to alchemy's per-tick toolkit rebuild — assessed honestly in §4.

**Compaction** is universal but treated as the *last* resort, in a now-standard escalation: (1) **tool-result clearing** — drop old tool outputs, keep the calls (Anthropic ships this as a platform feature; "once a tool has been called deep in the history, why would the agent need the raw result again?"); (2) **summarize-and-restart** — Claude Code's compaction passes the history to the model, preserves architectural decisions/unresolved bugs, discards redundant outputs, continues with summary + 5 most-recently-touched files; (3) **context reset with handoff artifacts** — for the longest horizons Anthropic found a fresh agent reading `progress.txt` + git log beats a compacted continuation (compaction keeps "context anxiety"; reset eliminates it). Manus adds the constraint that compression must be **restorable**: drop a web page's content but keep its URL; drop a document but keep its path.

**Recitation.** Manus's todo.md is rewritten and re-appended constantly, pushing the global plan into the model's recent attention span to fight lost-in-the-middle over ~50-tool-call tasks. Claude Code's todo list and Cursor's todo tool are the same mechanism productized. Note the *agency* difference: recitation is model-driven (the agent rewrites its own plan); alchemy's situation restatement is kernel-driven (the charter re-renders). Both put current goals at the context tail; they're complementary, not equivalent — recitation also forces the model to *re-derive* its plan, which is part of why it works.

**External memory / filesystem as context.** Manus treats the sandbox filesystem as "the ultimate context: unlimited, persistent, directly operable." Anthropic's just-in-time pattern: keep lightweight identifiers in context (paths, queries, URLs), load content on demand; CLAUDE.md is the up-front hybrid. The long-running-harness pattern makes files + git the *primary* state and the transcript disposable.

**Memory hierarchies for perpetual agents (MemGPT/Letta).** Main context = system instructions + **working context** (core memory blocks, agent-editable via `core_memory_replace/append`) + FIFO message queue. When pressure hits, evicted messages are replaced by a recursive summary and archived to **recall storage**; general knowledge goes to **archival storage**; both re-enter context only via search tools. Memory editing is *self-directed* — the agent is prompted with a description of its own memory hierarchy and manages it. Letta's current SDK adds MemFS: git-tracked memory files with background "dreaming" (idle-time memory reorganization). This is the only shipped lineage that takes "run in perpetuity with identity" seriously, and its answer is: the transcript is a *cache*; identity lives in self-edited structured memory.

**Skills / progressive disclosure.** Claude Code's SKILL.md is a three-tier scheme: (1) name + description (~100 tokens) always in the system prompt; (2) SKILL.md body loaded only when triggered; (3) bundled resources/scripts loaded/executed only when used (script *code* never enters context, only output). The description is the trigger surface; there's a character budget (~1% of context) with least-used-first eviction. Alchemy's `Skill` term (mention = access, `skill` tool activation returns the prose, tools enabled for the rest of the run) is the same three-tier idea, typed — validated by convergent evolution. One delta: Claude Code auto-triggers from the description match; alchemy requires explicit activation, which is more predictable and more cache-friendly.

**Few-shot rut & error retention** (Manus): keep failed actions and stack traces in context (evidence updates the model's priors; error recovery is the mark of real agency); inject small format variation to avoid the model miming its own history. Alchemy's `failureMode: "return"` (tool failure is a model-visible result, never a loop crash) matches the first point exactly.

---

## 4. Comparison with alchemy's charter/stance/kernel model

**What alchemy does that nobody ships: re-deriving the stance declaratively before every sampling.** The honest answer to the load-bearing question — *does any shipped harness re-derive full context/tools per step from declarative state?* — is **no**. Every production harness mutates incrementally: static system prompt, append-only transcript, imperative mode flags, injected reminder attachments. The closest analogs:

- **Vercel `prepareStep`** re-computes model/tools/system/messages per step — but it's an *opt-in imperative callback* that defaults to "no change", and its message overrides *persist* as the new base (mutation, not derivation). What Vercel's design signals: per-step recomputation of the four knobs (model, tools, system, messages) is the right *interface* for loop control; they just don't make it total or declarative. Their docs use it for exactly alchemy's use cases: phased tool availability (`activeTools` per step), compaction (`pruneMessages` on a threshold), model escalation.
- **OpenAI Agents SDK handoffs** switch the entire agent (instructions + tools) at a discrete boundary, carrying the transcript forward — stance switching by *agent identity swap*, coarse-grained, one-directional per turn.
- **Claude Code plan mode** is the richest shipped mode machinery and worth copying from precisely: a **hard gate** (permission layer blocks write tools — the model physically cannot bypass it) plus a **soft guide** (attachment messages injected into the turn, with a *progressive reminder* strategy: full instructions on entry, lightweight periodic refresh after, because full restatement every turn wastes tokens and breeds instruction fatigue), plus **save/restore** of the previous mode, plus a **fire-once exit attachment** ("you've exited plan mode"), plus `ExitPlanMode` carrying `allowedPrompts` — pre-approved commands that bridge plan into execution.

Alchemy's stance model is therefore a genuine synthesis rather than a copy: the frozen head = everyone's static system prompt; situation diffs = Claude Code's attachments (with the same latest-supersedes, deliver-only-on-change discipline); tool presence per tick = plan mode's permission gate, but derived from prose instead of a mode enum. The three mechanisms shipped harnesses implement separately (prompt, reminders, tool gating) fall out of one declaration. That's the innovation claim, and the practice survey largely supports it — *except* for one component:

**The per-tick toolkit rebuild has a real, quantifiable cost that Manus measured and alchemy should not wave away.** When a stance branch changes the rendered tool set (e.g. `issues.ts` flipping `triaging` → `awaiting-author` swaps `await_author` for `resume_triage`), the tool block sent to the API changes, and the KV cache is invalidated from the tools block — i.e. **essentially the whole context** — on the next sampling. Mitigating facts: alchemy only changes the toolkit when the stance actually changes branch (same branch → byte-identical tools → cache intact), and phase flips are rare relative to sampling (once per park/wake, not once per tool call), whereas Manus was reacting to per-step dynamic tool loading. So the amortized cost is one full re-prefill per phase transition — defensible. But there is a strictly better design available *only to alchemy*, because the charter's requirement channel already knows the **closed union of every tool any branch could mention** (that's what `CharterServices` computes): declare the full union in the API tool block for the run's lifetime (byte-stable, cached), and enforce this tick's stance subset by (a) provider-level `tool_choice`/allowed-tools constraints where supported, and (b) a kernel-level handler gate that returns a model-visible "not available right now" for out-of-stance calls (alchemy's `skill` tool already does exactly this for de-mentioned skills). Mention-in-prose stays the *authorization* semantics; the wire representation becomes mask-shaped. Manus's second argument (model confusion when history references undefined tools) also disappears.

**Modes.** Validated: shipped mode switching = tool gating + injected message, which is what the stance model does. The delta worth adopting: Claude Code's *progressive reminder* (don't restate the full stance every tick; alchemy already does better — only on change) and the *fire-once transition message* (alchemy's situation supersession covers this) — but also plan mode's **save/restore and explicit approval-to-transition** pattern: mode changes that expand authority (plan→execute) are gated on an external approval, not just the model's own tool call. In alchemy terms: phase-advancing tools that *increase* capability should be wired through the Process Layer (world approval) rather than self-served, which the Process/Agent split already makes expressible.

**Steering.** Fully validated (§1). Alchemy's queue-and-promote-at-boundary is Codex's `turn/steer`, the strictly better of the two shipped behaviors.

**Perpetuity is alchemy's biggest gap versus practice.** `KernelMemory`'s `prompt` grows without bound: no compaction, no tool-result clearing, no memory hierarchy, no transcript reset. Every shipped long-horizon system converged on "bounded episodes over durable external state" (Anthropic relay, Devin sessions+knowledge, LangGraph threads with pruned checkpoints) or "self-editing memory with summary eviction" (MemGPT/Letta). Alchemy has a structural advantage here that no transcript-centric harness enjoys: **the stance is re-derived from world state and `AI.local`s every tick, so the transcript carries less irreplaceable state than in any other harness** — the head can be recomputed, the situation restates itself, phase lives in locals, and the world (GitHub) holds ground truth. That makes aggressive transcript management *safer* in alchemy than anywhere else. The park boundary is the natural compaction/reset point: a parked run has, by definition, reached quiescence.

**Multi-agent.** The Cognition/Anthropic split resolved into a shared rule by late 2025 (Cognition's own follow-up): **writes stay single-threaded; parallel subagents contribute intelligence (reads, research, review), not actions** — read-only subagents "mostly resemble tool calls." Anthropic's system fits the rule (research = breadth-first reads; one lead agent writes the report; subagents return condensed 1–2k-token summaries, big artifacts go to the filesystem and pass by reference). Alchemy's model straddles the line: `spawn` (anonymous leaf workers, tool-subset, no recursion, task-stated-completely) matches Claude Code subagents and the read-worker pattern well. `dispatch` to a named Agent with "the delegate never sees the host's conversation" is *exactly* the game-of-telephone Cognition documents — acceptable when the task statement is genuinely self-contained (the Engineer receiving one fully-specified issue is the good case: the *charter forces* acceptance criteria to be complete before dispatch, which is context engineering by process design), dangerous when it isn't. The practice-derived rule for alchemy: delegates that *write* should receive world-anchored references (issue URL, branch, files) rather than prose summaries, and hosts should pass artifacts by reference — both already expressible, worth stating as doctrine.

**Durability.** In practice, **snapshot-at-boundary beats event replay**. LangGraph checkpoints full graph state per superstep into a thread; interrupt/resume and time-travel are checkpoint reads; their documented failure mode is unbounded checkpoint growth. Temporal-based agent stacks event-source the *workflow*, but LLM calls are non-deterministic activities — replay never re-samples, so what's replayed is effectively the snapshot sequence anyway. Anthropic's research system: "regular checkpoints + resume from where the agent was + let the model adapt to surfaced tool failures," plus rainbow deploys because agents are mid-flight during code pushes. For alchemy the natural mapping is clean because the kernel contract already excludes durability from the loop's vocabulary: a `KernelDurable` Layer that persists `{key, locals, active skills, frozen head, transcript-or-summary}` at every **park** (quiescence) and rehydrates runs lazily on `steer`/`send` to a cold key. Park-time snapshots also solve deploy-time draining: settle-in-memory, resurrect-from-snapshot.

**Charter complexity & many runs.** Practice offers comfort: Claude Code's monolithic prompt + mode flags + attachment injections is *harder* to reason about than a charter with typed branches, and the per-tick turn evaluation is local Effect execution — negligible next to a model call. One run per issue with a mailbox each is lighter than LangGraph's thread-per-conversation with Postgres checkpoints. The scaling risks are the unbounded transcript (above) and the missing step/cost budget, not the charter mechanism.

---

## 5. Steal / adapt / reject

**Steal (do these):**

1. **Step & cost budgets on the loop** (everyone ships one; Vercel's `stopWhen` is the cleanest API). Kernel-level, per-run:

```ts
// KernelMemory option, enforced in loop()
interface RunBudget { readonly maxSteps?: number; readonly maxCost?: number }
// on breach: park the run and emit a situation —
// `<situation>Budget exhausted after 40 steps; summarize state and stop.</situation>`
```

Breaching should *park with a situation*, not crash — the world (or an owner charter) decides whether to grant more.

2. **Tool-result clearing as the first compaction lever** (Anthropic ships it as a platform feature; lowest-risk compaction known). A pure `Prompt → Prompt` transform in the loop: replace tool-result parts older than the last N assistant turns with `[result cleared — re-run the tool if needed]`. Restorable in Manus's sense when the tool is idempotent.

3. **Compaction/reset at the park boundary.** A parked run is quiescent — the perfect moment. On park (or on a token threshold), summarize the transcript through the model (Claude Code's recipe: preserve decisions, open questions, unresolved errors; discard raw outputs) and restart the run's prompt as `head + summary-as-situation`. Because alchemy's stance re-derives from locals/world, this is a *reset with handoff artifact* (the strongest pattern per Anthropic's long-running post), not a lossy compaction — the summary is the only transcript-borne state that needs carrying.

```ts
// sketch: in loop(), replacing the PARK block
if (quiescent && (yield* estimateTokens(prompt)) > compactAt) {
  const summary = yield* summarize(prompt, model);        // decisions, open threads, errors
  prompt = Prompt.make([situationMessage(`Prior work summary:\n${summary}`)]);
}
```

4. **Durability Layer snapshotting at park** (§4): persist `{key, locals, active, head, summary}`; rehydrate lazily on wake. Snapshot, not event-replay — matching LangGraph/Temporal practice.

**Adapt (change shape, keep the idea):**

5. **Union-toolkit + stance masking** (the Manus correction, §4). Compile the charter's *closed* tool union once per interpretation (the type system already computes it); send it byte-stable every tick; enforce the per-tick stance subset via provider `tool_choice` constraints where available plus a kernel handler gate returning a model-visible refusal (`"await_author is not available while triaging"`). Mention-in-prose remains the semantics; the wire becomes cache-stable. Fall back to today's rebuild for providers without tool-choice constraints — the amortized cost (one re-prefill per phase flip) is acceptable there.

6. **Recitation for long active segments.** Situation messages fire only on change; a run 60 tool calls into one phase has its goals lost in the middle. Add a kernel policy: re-inject the current situation (or the stance's tail block) every K assistant turns *within* a phase — Manus's todo.md effect, kernel-driven. Cheap (append-only, cache-safe).

7. **A memory-block local + note-taking doctrine.** MemGPT's core-memory insight, in alchemy idiom: an `AI.local`-backed working-context block that the charter *renders into the stance* and the agent edits through an inline tool — self-editing memory without adopting Letta's machinery:

```ts
const notes = yield* AI.local("");
const remember = AI.Tool("remember")`Replace your working notes.`(
  (p: { text: string }) => notes.set(p.text).pipe(Effect.as("noted")));
// TURN: …${yield* notes.get}… ${remember}…
```

Caveat: an edited block changes the situation text → one situation message per edit (append-only, so cache-safe). For durable cross-run memory, follow Devin/Letta/Anthropic and use the filesystem/world (a `memory/` prefix, a GitHub comment) rather than inventing a store.

8. **Delegation doctrine from the Cognition rule.** Type or document the read/write split: parallel `spawn` for reads/research/review freely; `dispatch`-that-writes must carry world-anchored references and complete task statements (the Issues charter's "READY" gate is already the right enforcement shape — make it the documented pattern). Support pass-by-reference artifacts (delegate writes to the world, returns a URL/path) per Anthropic's appendix.

**Reject (deliberately not adopt):**

9. **LangGraph-style explicit graphs for the inner loop.** No shipped evidence they help inside the sampling loop; the charter's prose-branching plus the Process Layer's event wiring covers what graphs buy at the workflow level, with types.
10. **OpenAI-style handoffs as the mode primitive.** Agent-identity swap is a coarse special case of stance re-derivation; alchemy's model strictly subsumes it (a charter branch that renders a different persona *is* a handoff without losing the run).
11. **Auto-triggered skills from description matching** (Claude Code). Explicit activation is more predictable, cache-friendlier, and the `skill` tool's listing already gives the model the trigger surface. Revisit only if activation friction shows up empirically.
12. **Fine-grained logit masking / response prefill** (Manus's exact mechanism). Provider-dependent and unavailable over public APIs at that granularity; the union-toolkit + `tool_choice` + handler-gate adaptation (#5) captures the benefit portably.

---

## 6. Open questions

1. **Provider tool caching specifics.** How exactly do Anthropic/OpenAI cache the tools block relative to system and messages (Anthropic's `cache_control` breakpoints; OpenAI automatic prefix caching)? This determines how much #5 is worth versus the rebuild's amortized cost. Needs measurement, not literature.
2. **Situation-message fatigue.** Claude Code found *repeating* full instructions every turn weakens them ("instruction fatigue") — does full-restatement-on-change plus recitation-every-K hit the same failure? Only empirical evals on long runs will tell.
3. **Summary fidelity at reset.** Cognition trained a dedicated compression model because prompt-based summarization loses decisions. Is prompt-based park-compaction good enough for alchemy's runs, given the stance re-derives most state? Likely yes (less rides on the transcript), but the claim should be tested on a long-lived Issues run.
4. **Settled-run memory.** When the world settles `owner/repo#7`, its locals and transcript vanish. Devin's knowledge and Letta's dreaming both extract durable lessons from ended episodes. Should settle offer a hook — a final turn whose only affordance is "write down what the org should remember"?
5. **Cross-run coordination.** Each keyed run is context-isolated; two issues about the same bug never see each other except through the world. Practice (Cognition: shared plan files; Anthropic: filesystem artifacts) suggests the world/filesystem is the right shared medium — but is a kernel-level read-only "org situation" block (rendered into every stance) worth having?
6. **Budget governance.** Anthropic embeds effort-scaling heuristics in prose; Vercel makes budgets code. Alchemy can do both (charter prose + kernel budget) — where should the authority live when they disagree?
