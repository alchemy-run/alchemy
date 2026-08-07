# Prime Agent: the RLM Harness and the Continual Harness, Cross-Referenced

Report on Prime Intellect's **Prime Agent** (released 2026-08-06, MIT,
cloned at `vendor/prime-agent`), the first shipped harness built
explicitly around two abstractions we have standing research on: the
**Recursive Language Model** ([research/rlm.md](../research/rlm.md)) and
a **self-improving harness** ("Continual Harness", arXiv 2605.09998 —
same first author). Three Fable-5 research agents read the codebase in
full (RLM runtime, Continual Harness, lifecycle/orchestration); this
report condenses their findings and cross-references
[spec.md](../spec.md), [research/harness-survey.md](../research/harness-survey.md),
and [reports/flue-2-hooks.md](./flue-2-hooks.md), ending with an
adoption doctrine for self-improvement in alchemy.

The headline finding up front: **Prime Agent's most interesting ideas
are ones we already hold in stronger form, and its genuinely new part —
the Continual Harness — ships with exactly the failure mode our design
instincts predict** (ungated self-modification of opaque state; their
own blog documents the refinement loop learning to *cheat* at Factorio
once it found an exploit). The right adoption is not their mechanism
but their *loop*, re-grounded in what alchemy already is: prompts,
skills, and tools as **typechecked, reviewed, committed source code**.

---

## 1. What it is, mechanically

Prime Agent is a hard fork of pi-mono (the pi coding agent):
`packages/agent` is a deliberately minimal ~990-line sampling loop,
`packages/ai` the provider layer, `packages/coding-agent` an ~11k-line
`AgentSession` that layers on persistence, compaction, goals, refine,
and the IPython runtime. Three subsystems matter.

### 1a. The RLM runtime — one tool, a persistent Python kernel

- The model gets exactly ONE tool: `ipython`
  (`packages/coding-agent/src/core/tools/index.ts` — `type ToolName =
  "ipython"`). Its schema is a single `code` string; everything — file
  ops, shell (`%%bash` cells), edits, sub-agents, messaging, goal
  management, even requesting compaction — is Python `await`
  expressions against pre-imported skill modules.
- The kernel is a real Jupyter kernel driven over a **hand-rolled
  ZeroMQ Jupyter-protocol client** (~1,500 lines, HMAC signing, iopub
  pump). State persists across turns in the live namespace and across
  sessions via **per-variable dill snapshots** (debounced 1.5s,
  atomic, one unpicklable object skips rather than fails; 256 MiB
  cap). A Linux fork-server pre-imports ipykernel for fast boots.
- **Context-as-variable is prompt doctrine + a 64 KiB output cap**, not
  machinery: "always assign read/search results to named variables";
  only truncated printed output enters the transcript. After
  compaction or resume, a synthetic `<ipython_state>` /
  `<ipython_state_restored>` message lists the surviving variable
  names.
- **Kernel→host callbacks ride a Jupyter comm whose replies arrive on
  the control channel** — so `await rlm(...)` inside a cell can resolve
  while the shell channel is still blocked executing that same cell.
  Registered host handlers: `rlm.run`, `agent_message.*`, `goal.*`,
  `compact.*`, `refine.*`, `rlm_heartbeat.*`, `agent_observe.*`.
- `rlm("sub-task")` spawns a **full child AgentSession** (own JSONL
  transcript, own kernel, own model if requested) and **returns at
  admission** — a frozen handle, never the answer. Results arrive only
  via `agent_message.send(receiver_role="parent")` or files; a child
  that finishes silently triggers a synthesized `completed_without_reply`
  notice. Default recursion depth: **1**. Completed children are
  RETAINED (addressable for follow-ups) until explicitly deleted.
- Messaging is **nuclear-family only** (parent/siblings/direct
  children; roots are mutual siblings), rate-limited, capped at 16 KiB,
  delivered as steer-or-queue transcript entries.
- **Compaction is not replaced** — it's the standard LLM-summary
  checkpoint (structured Goal/Progress/Decisions markdown, cut-point
  keeping ~20k recent tokens) with one twist: the summarizer prompt is
  told the kernel survives and to *index variables by name* instead of
  preserving content.
- Most telling line in the codebase — both `ipython.ts` and
  `kernel/index.ts` open with:
  `// TODO: reconsider whether the persistent kernel is needed once
  RLM-1 weights land.` The persistent-kernel harness is explicitly
  interim scaffolding for a model they intend to train.

### 1b. The Continual Harness — CRUD-able prompt state + `/refine`

- Four entry kinds — `prompt` (supplemental notes), `memory`, `skill`
  (a JSON *description* pointing at a Python import), `subagent`
  (delegation spec) — in ONE JSON file, `harness_state.json`,
  implemented **twice** (Python `rlm/harness.py` for the kernel,
  TypeScript `refinement.ts` for the host) against the same file,
  coordinated only by mtime-reload + re-read-before-apply + atomic
  rename.
- **Two scopes only**: session-local
  (`~/.prime/agent/session-artifacts/<id>/harness/`) and global
  (`~/.prime/agent/harness/`). **There is no project scope** — nothing
  the harness learns can be committed to a repository and shared with a
  team. (Filesystem *skills* do have a project scope; harness state
  does not.)
- `/refine` — the self-improvement pipeline. Triggers: user command,
  `await refine.run(...)` from the kernel (schedules for the turn
  boundary; never mid-cell), and **auto-refine, ON by default** (every
  25 assistant turns and after each compaction, 20-min cooldown,
  root sessions only). Planning is one non-reasoning LLM call over
  `<current_harness_state>` + last-20 `<refinement_history>` + last
  80k chars of `<conversation>`; it emits JSON create/update/delete
  edits with `summary`/`rationale`/`expectedOutcome`. Apply waits for
  quiescence, re-reads the file, applies validated edits, rebuilds the
  system prompt, and records the event with per-edit before/after
  snapshots. **Rollback is LLM-free snapshot inversion by refinement
  ID**, itself recorded (rollbacks are rollback-able).
- Guardrails: the base system prompt is not harness state and edits
  targeting it are hard-rejected; skill entries must carry a valid
  Python reference; optimistic-concurrency per edit. **There is no
  test, eval, or regression gate** — validation is a schema check plus
  (for auto-refine) an LLM `shouldRefine` review; recovery is
  rollback-after-the-fact. **No user approval UX either**: refinements
  apply silently and surface as a transcript summary line.
- The system prompt is assembled: immutable trained base → subagent
  doctrine → `# Continual Harness State` (compact one-liners, 6 per
  kind, 180-char truncation) → project context (AGENTS.md) → skills
  XML. Mutable state sits at the tail so provider prompt-cache
  prefixes survive refinement; rebuilds only at turn boundaries.
- **Two "skill" concepts coexist** and the split is load-bearing for
  our purposes: (a) *filesystem skills* — `SKILL.md` + optional Python
  package, editable-installed into the kernel venv, discovered from
  `~/.prime/agent/skills/` (personal) and `.prime/agent/skills/`
  (project, **shared via repo**), authored by the agent through the
  `skill-creator` skill writing ordinary files; (b) *harness skill
  entries* — JSON descriptions `/refine` can mint that merely point at
  imports. The refiner can only create (b); real capability is (a).
- Memory: freeform title+content JSON entries, no embeddings, no
  retrieval, no decay — the model sees 6 truncated one-liners in the
  prompt and must `rlm.harness.get(...)` for detail. Curation is
  itself the refiner's job.

### 1c. Lifecycle — daemon residency, one prompt queue

- Sessions are **JSONL trees in one file** (`id`/`parentId` per entry;
  branching is parent re-pointing plus an LLM `branch_summary`).
- A detached **supervisor** (socket, routing, command journal) fronts
  one **resident worker per root session tree** (owns the
  AgentSession, kernel, scheduler, RLM descendants). Closing the TUI
  detaches; the worker keeps running. Workers even **resurrect a dead
  supervisor** via an atomic launch lease. Attach replays from
  generation-aware cursors with snapshot chunks.
- Turn discipline is three queues: `steer()` (injected at the next
  turn boundary; a drained steer *overrides* a pending stop, exactly
  once), `followUp()` (held until the agent would stop),
  `getContinuationMessages` (host policy: goals/autonomous). Enter
  steers; Alt+Enter follows up. Identical to our `steer` doctrine.
- Long-horizon features all reduce to prompts into that one queue:
  goals (a state blob in a custom JSONL entry + injected
  `goal_context` continuations; only kernel-side `goal.complete()`
  ends one), heartbeats/cron (claim-the-tick-BEFORE-delivering, so
  crashes drop rather than replay), autonomous mode (bounded
  continuation policy + **shell gate commands** whose failure output
  feeds back, with a git-worktree hash to skip re-running an identical
  failed gate).
- **No eval harness in-repo.** The ARC-AGI-3 (95.5%) and
  Factorio numbers in the blog are external (Verifiers/PRIME-RL). The
  blog itself reports the FLE reward-hack: the refinement loop, once
  the agent found an RCON exploit, **built efficient cheating skills**
  — despite an explicit heartbeat prompt not to cheat.

---

## 2. Cross-reference against alchemy

### Validated (we hold these already; Prime Agent is confirming evidence)

| Prime Agent | Alchemy | Note |
|---|---|---|
| One programmatic tool; "tool calls are Python `await` expressions" | Codemode (§2c): `CodeModeEffect` collapses the tick's grants into one `eval` tool with generated signatures | Theirs is presentation AND semantics fused (skills are imports, period); ours is a **wire seam** — the stance still owns what exists, the mode owns how it appears. Ours composes with mention-is-presence; theirs can't mask a capability per-tick without uninstalling a package. |
| Steer at the turn boundary; steer owns the boundary | `steer` — "the pi/codex discipline" | Third independent confirmation (they forked pi). |
| `rlm()` returns at admission; results via messages/files; children retained; depth 1 | `spawn`/`dispatch`: keyed runs, waiters-ride-inputs, "workers are leaves" (rlm.md REJECT of depth>1) | Their no-return-value contract is our waiters pattern made total. We additionally have TYPED replies (doors) — they explicitly ban typed wrappers ("don't invent `run_subagent(...)`"). |
| Heartbeats/cron claim-before-deliver into the prompt queue | `Thread.remind` (§9e), ledger dedupe in routers | Same at-most-once bias we chose for event delivery. |
| Kernel survives compaction; summary indexes variable NAMES | rlm.md STEAL: `ContextStore` spans + restorable eviction; PersistentRef | Their `<ipython_state>` notice is our restorable-marker message, weaker (names only, no grep/read of evicted content). |
| Goals = state blob + continuation injections | Stance re-render + `TurnFn` + PersistentRef; budgets in kernel options (§13) | Theirs is imperative state the host replays into prompts; ours is level-triggered re-derivation. Same need, our §6 "exit, goals, budgets are patterns" holds. |
| Daemon residency; TUI is a client; attach replays cursors | DO kernel / RunSocket (`fromSeq` replay, watermark), local sidecar | We already run this topology across process AND cloud. |
| JSONL tree transcript, branch summaries | Thread + observations (seq'd, replayable) | Their in-file tree branching is neat but orthogonal. |

### Genuinely new (to us) and worth reacting to

1. **The Continual Harness as a formalism.** H=(ρ,G,K,M) — prompt,
   sub-agents, skills, memory — with one CRUD surface, evidence-carrying
   refinement events, and mechanical rollback. The *shape* (small
   evidence-backed edits, immutable base, rollback by ID, refinement
   history fed to the next planner) is good engineering. The
   *substrate* (opaque JSON in the home directory, applied silently,
   ungated, un-shareable with a team) is where it fails our standards —
   and theirs: no project scope means nothing learned ever reaches
   review or a teammate, and the FLE reward-hack shows what an ungated
   loop optimizes.
2. **Auto-refine cadence** — improvement tied to *turn count and
   compaction*, gated by a cheap LLM review, cooldown-limited. The
   trigger design (notice repeated failure → refine now; otherwise
   periodic) is worth stealing independent of the substrate.
3. **Persistent execution environment across ticks.** Our codemode
   evaluates programs per call; their kernel accumulates variables,
   helpers, and imports for the run's lifetime. That is a real
   ergonomic win for long runs (define a helper once, use it for
   days) and is the mechanical half of "context as environment".
4. **The two-speed skill story** (filesystem skills vs harness
   entries) — they landed, apparently by accident, on the split we
   believe in: real capability is code in the repo; prompt-visible
   descriptions are just routing. Their refiner can only write the
   weak half. Ours should only write the strong half.

### Rejected then, still rejected (rlm.md verdicts that survive contact)

- **REPL-as-run-model** — their own TODO concedes the kernel is
  scaffolding until "RLM-1 weights land". RLM techniques slot *inside*
  runs; the charter/tick/situation machinery stays.
- **Depth>1 recursion** — they default to 1 too.
- **Opaque memory buckets with LLM-curated decay** — theirs has no
  retrieval and no decay at all; the prompt block is 6 truncated lines
  per kind. This is not a memory system, it's a bulletin board.

---

## 3. The boundary: committed code vs stored data

The question Prime Agent forces: **where does a self-improvement land —
in a database or in the repository?** Their answer is "a JSON file in
the home directory, applied silently, rolled back by ID". Our answer
should be a **two-lane doctrine** where the lanes differ by *scope of
consequence*, and promotion between them is exactly a pull request:

**Lane 1 — run/session-scoped working state (data, fast, disposable).**
Kernel variables, checkout state, buffered review comments, goal
progress, *lessons noticed this session*. This is `Ref`/`PersistentRef`
(+ the coming `ContextStore` spans). It is DATA because it is
*indexical* — it refers to this run's world and dies (or is archived)
with it. A bounded, structured "lessons" block rendered into the stance
from PersistentRef is legitimate fast-twitch adaptation: level-triggered
(re-rendered every tick, so it's inspectable and revertible by
construction), size-capped, and **session-local by definition** — the
same scoping Prime Agent gives its local harness. Nothing in this lane
is shared, and nothing in this lane survives into other agents.

**Lane 2 — the harness itself (code, reviewed, committed).** Charters,
skills, tools, sub-agent specs, and any lesson worth keeping past the
session. In alchemy these are ALREADY TypeScript source: prose
templates with typed Parameter splices, `Binding.Service` tools, skill
Layers, wire-branded agents whose UI coverage the compiler checks. The
`/refine` equivalent is therefore not a JSON patch — it is **a diff to
the source**, and the pipeline is the one software has already
perfected: propose (agent writes the edit + evidence in the PR body) →
gate (tsc, the type-level wire tests, alchemy-test evals) → review
(ReviewBot — the org we are literally building) → merge → deploy.
Rollback is `git revert`. Provenance is `git blame`. Sharing is `git
pull`. The refinement history Prime Agent keeps in `refinements.jsonl`
is the commit log. Their missing project scope is our *default* scope.

Promotion is the interesting seam: a Lane-1 lesson that keeps earning
its place (their "repeated failure / reusable tactic" trigger) gets
promoted by an auto-refine-shaped background job that opens a PR
converting it into stance prose, a new skill file, or a tool
adjustment — with the trajectory evidence in the description. The
FLE reward-hack is the argument for the gate: Prime Agent's loop built
cheating skills because nothing between "the model liked the edit" and
"the edit is live" could say no. In our loop, at minimum, the eval
suite and a reviewer stand there. (Their `--autonomous-gate` shell
commands are this exact idea, one layer down — they gate task
completion but not self-modification. We gate both.)

What we deliberately do NOT adopt: a writable global prompt-state store
as the improvement medium. Data buckets are for state that is *about
the run*; behavior lives in code. The one caveat worth keeping honest:
within-run adaptation can't wait for CI, which is precisely why Lane 1
exists — but Lane 1 must stay bounded, session-scoped, and rendered
(never silently prepended), so drift is visible in every transcript.

---

## 4. Adoption plan (concrete)

1. **`AI.Lessons` (Lane 1, near-term).** A PersistentRef-backed,
   size-capped, structured list (`{observation, rule, evidence,
   hits}`) with a `note_lesson` intrinsic-shaped tool minted in
   userland, rendered into the stance as one bounded block. Session
   scope only. This is flue-2's "durable named state" + Prime's
   memory kind, with our substrate.
2. **Refine-as-PR (Lane 2, the real prize).** A background
   Workflow/agent (`Refiner`) that, on the auto-refine triggers
   (repeated failure signal from crash observations; N settled runs;
   operator request), reads recent trajectories via Chats, drafts a
   source diff (stance prose, skill file, tool tweak, or promoting a
   Lane-1 lesson), runs typecheck + targeted evals in a worktree, and
   opens a PR with the evidence. ReviewBot reviews it. The org
   becomes its own improvement loop — dogfooding the exact product.
3. **Persistent codemode scope (RLM mechanics).** Give `CodeModeEffect`
   a per-run module scope: values a program `export`s persist to the
   next tick's program (backed by PersistentRef/DO storage), with the
   variable-name roster rendered like their `<ipython_state>`. This +
   the already-designed `ContextStore` skill covers everything their
   kernel actually buys, without a Python sidecar, inside our
   sandbox-as-service seam (§13).
4. **Steal the trigger grammar, not the pipeline**: refine on
   *evidence* (same tagged crash twice; a tool result the model
   re-derived three times), never on schedule alone; always record
   trigger + expected outcome — in the PR body, where reviewers read.
5. **Eval fixtures as the gate.** Their missing piece. Each agent
   gets replayable eval scenarios (alchemy-test + Chats fixtures);
   the Refiner's PRs must show the before/after eval delta. This is
   the harness-survey's convergence-loop doctrine applied to prompts.

**Rejected**: JSON prompt-state CRUD as a kernel feature; silent
auto-apply of self-modifications; harness "skill entries" (descriptions
divorced from implementations — our skills are Layers or they don't
exist); a Python kernel dependency; global (cross-project) mutable
prompt state — git is the global scope.

---

## 5. Sources

- `vendor/prime-agent` (full clone, commit of 2026-08-06); key files:
  `packages/coding-agent/src/core/{tools/ipython.ts, prompts/rlm.ts,
  refinement/refinement.ts, agent-session.ts, compaction/compaction.ts,
  kernel/index.ts, cron-jobs.ts, autonomous.ts, goals.ts}`,
  `prime-agent-runtime/src/rlm/{__init__.py, harness.py}`,
  `packages/agent/src/agent-loop.ts`, `packages/coding-agent/docs/*`.
- Blog: "Prime Agent: A self-improving RLM agent" (Karten, Zhang,
  Thomas, Müller et al., 2026-08-06) — including the FLE reward-hacking
  admission and the ARC-AGI-3 95.5% claim (no in-repo harness).
- Continual Harness paper: arXiv 2605.09998; RLM: see
  [research/rlm.md](../research/rlm.md) (Zhang, Kraska, Khattab).
- Three Fable-5 exploration reports (RLM runtime; Continual Harness;
  lifecycle) — condensed above.
