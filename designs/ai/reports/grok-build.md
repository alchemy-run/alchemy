# Grok Build (xai-org/grok-build) — study for Alchemy AI

Studied at `main` (shallow clone, Jul 17 2026), vendored at `.vendor/grok-build`. All file:line references are into `.vendor/grok-build/` (most paths under `crates/codegen/`). Grok Build is xAI's terminal coding agent (`grok`): a Rust workspace of ~60 crates synced from their monorepo, spanning a full-screen TUI, an ACP agent server, a leader/multi-client daemon, and — the part this study cares most about — the most operationally mature **verified goal loop** shipped by any harness surveyed so far.

---

## Architecture overview

```
crates/codegen/
  xai-grok-pager(-bin)      ← the TUI (+ docs/user-guide/*.md — 24 load-bearing runtime docs)
  xai-grok-shell/           ← THE BRAIN: session actor, turn loop, tools dispatch, goal harness
    src/session/acp_session_impl/   run_loop.rs (857) turn.rs (2463) tool_calls.rs (3013)
                                    goal.rs (2475) sampler_turn.rs (1070) …
    src/session/            goal_{tracker,classifier,planner,strategist,summarizer,
                            stop_detector}.rs (~18k LOC of goal machinery), compaction.rs (3321),
                            persistence.rs (4003), storage/ (JSONL), memory/, worktree*.rs
    src/leader/             one-agent-many-clients daemon (Unix socket, server.rs 6207)
  xai-chat-state/           ChatStateActor — owns Vec<ConversationItem>, usage ledgers, pruning
  xai-grok-sampler/         model I/O actor: 3 wire APIs, streaming, retry (~15k LOC)
  xai-grok-sampling-types/  ConversationItem + dangling-tool-call repair (conversation.rs ~9.5k)
  xai-grok-agent/           built Agent: MiniJinja prompt templates (XOR-obfuscated), presets,
                            AGENTS.md discovery, skills index
  xai-grok-tools/           ~45 tool impls in 3 namespaces: GrokBuild (original) + literal
                            source PORTS of openai/codex (4 tools) and sst/opencode (8 tools)
  xai-grok-workspace(-client/-types)  Local vs Proxy execution seam (remote workspace RPC)
  xai-grok-sandbox/         nono-based Landlock/Seatbelt, process-lifetime + child seccomp net
  xai-grok-hooks/           Claude/Cursor-compatible hook engine (subprocess/HTTP, JSON stdin)
  xai-grok-mcp/             MCP client (stdio/HTTP/SSE, OAuth) + search_tool/use_tool meta-tools
  xai-grok-memory/          markdown memory files + sqlite-vec embeddings + idle flush + dream
  xai-grok-subagent-resolution/  pure spawn-context/overrides; forked-context normalization
  xai-agent-lifecycle/      data-only hook contributors — "they never own loop control"
  xai-acp-lib/              ACP JSON-RPC framing (the agent server lives in shell)
  ptyctl/, xai-fast-worktree/, xai-hunk-tracker/, xai-codebase-graph/  …
```

Where the brain lives: `xai-grok-shell/src/session/acp_session_impl/turn.rs` (`process_conversation_turn`) is the act–observe loop; `goal_tracker.rs` + `acp_session_impl/goal.rs` + `goal_classifier.rs` are the outer verified-goal loop; `xai-chat-state` is the state actor; `xai-grok-sampler` is the provider boundary. Note the misdirection in two crate names: `xai-sqlite-journal` is *not* an effect journal (it only picks SQLite WAL-vs-TRUNCATE per filesystem — a 779-line NFS-hazard workaround), and `goal_orchestrator.rs` is *not* the orchestrator (notification formatting only; the module doc says so).

---

## 1. The loop

**Three nested async loops**, actor-shaped, no pure state machine:

- **Session actor** — `run_session` (acp_session_impl/run_loop.rs:33–153): one `tokio::select!` (biased) over commands, prompt completions, chat-state events, idle memory-flush timer, dream timer, model-switch watch. Each prompt spawns a `handle_prompt` task; the actor stays responsive for cancel/steer.
- **Prompt loop** — `handle_prompt` (turn.rs:759–792): after each conversation turn, if a goal is Active, `run_goal_round_end()` may inject a continuation directive and loop (`GoalRoundDecision::Continue | EndTurn`).
- **Core agentic loop** — `process_conversation_turn` (turn.rs:1799–2305): drain interjections → reminders/MCP refresh → auto-compact preflight → build request from the chat-state actor → sample (`SamplerTurnOutcome::Response | CompactAndResubmit | RefreshAuthAndResubmit`) → record assistant/reasoning items → if no tool calls, gates (below) then `Completed`; else execute tools, check `max_turns`, repeat.

There is no `enum AgentState` — phases are *emitted events* (`PhaseChanged { WaitingForModel | ToolExecution }`) while control flow is `loop`/`continue`/`return`. ~7 outcome enums with ~25 variants (`TurnOutcome`, `ToolLoop` with 7 variants incl. `PermissionReject`/`HookDenied`/`FollowupMessage`, `TodoGateDecision`, `GoalRoundDecision`, `CapturePhase`) carry the decisions.

**Exit gates on "no tool calls"** — the default exit is guarded by a stack of deterministic gates that can refuse it: **TodoGate** (open todos ⇒ inject reminder, re-loop; capped `max_fires_per_prompt`), **completion requirement** (agent def may require a named tool call before finish; recovery injects `AutoRecovery` and retries), **goal continuation** (goal Active ⇒ never stop), **laziness classifier** (post-turn stall detector, nudge with per-session cap), structured-output enforcement. Termination-is-policy, concretely.

**Budgets**: `max_turns` (per-agent-definition, counts tool cycles), sampler HTTP retries (default 15, ~6 min cap), auth-incident retries (3, 1s/2s/4s), TodoGate/laziness nudge caps, goal token budgets (below). No global step ceiling otherwise.

**Steering — three typed doors** (this is pi's queues, hardened):

1. **Queue** (FIFO): `queue_input` with wire metadata (`xai-prompt-queue`); reorder/edit/remove/clear ops on the queue are first-class session commands.
2. **Interjection** (steer): mid-turn text lands in a shared `PendingInterjection` buffer, drained at two safe points — top of each loop iteration and *again before declaring Completed* (turn.rs:1802, 2164–2180) — injected as a `UserItem` tagged `SyntheticReason::Interjection`. A queued prompt can be atomically *promoted* into an interjection (`handle_interject_queued_prompt`) so it can't both steer and later run as its own turn.
3. **Send-now** (interrupt): cancels the running turn (kill foreground terminals, preserve the queue), auto-selected when the turn is blocked in an interruptible wait.

**Tool-pairing invariant**: `repair_dangling_tool_calls` (sampling-types/conversation.rs:2767–2824) inserts synthetic `ToolResult`s for unanswered call ids, with typed reasons `UserCancelled | HarnessHalted { class }`; interruptible waits synthesize `"Wait interrupted: the user sent a message."` cancelled results; `dedup_duplicate_tool_results` handles a real result racing a synthetic one. Repair runs at **write boundaries** (actor startup, `push_user_message`, request build, explicit `RepairHistory` command guarded by a turn-active flag) — repair-on-write, not Codex's repair-on-every-read.

**Model-visible injection provenance**: every synthetic user message carries `UserItem.synthetic_reason` — `Interjection | SystemReminder | AutoContinue | AutoRecovery | TaskCompleted | SubagentCompleted | GoalClassifierNudge | …`. The injected-message taxonomy is typed on the message itself.

## 2. The /goal harness (the crown jewel)

A long-horizon verified goal loop, ~18k LOC across `session/goal_*.rs`. `/goal <objective> [--budget N]` creates durable state (`goal/state.json`), snapshots the **git HEAD as a baseline commit**, runs a planner, and prepends a `<system-reminder>` to the same turn so inference continues seamlessly (acp_session_impl/goal.rs:1557–1622).

**The worker is the parent model; the harness owns verification.** Roles are subagents with explicit failure polarity:

| Role | When | Failure polarity | Writes |
|---|---|---|---|
| **Planner** | on `/goal` setup and on resume-without-plan | **fail-closed** (no plan ⇒ pause) | `goal/plan.md` + a frozen `plan.baseline.md` |
| **Strategist** | after N consecutive NotAchieved verdicts | fail-open | `goal/strategy.md` ONLY — a `PlanGuard` **reverts any plan.md edits it makes**; charter: change HOW, never WHAT |
| **Summarizer** | once, after Achieved | fail-open | read-only pin; ≤80-word closing message |
| **Skeptic panel** | when the model calls `update_goal(completed: true)` | infra failure ⇒ `FailOpenAchieved` | private scratch dirs |

**Halt-as-tool**: done-ness is exactly a tool call — `update_goal { completed?, message?, blocked_reason? }` (xai-grok-tools/.../update_goal/mod.rs:29–50). The harness never auto-completes from "looks done" prose.

**The adversarial skeptic panel** (goal_classifier.rs, 6,586 lines + evidence.rs 2,199): N=3 independent skeptic subagents run in parallel (clamp 1..=5), each returning a JSON verdict (terminal-token fallback `Refuted`/`Not Refuted`). Aggregation is **majority-refute over the *cold* skeptics, with skeptic 0 as a persistent gatekeeper** — it keeps its session across verification rounds (`skeptic0_session_id`) and its decisive refute blocks Achieved even against a cold majority. The verifier prompt's load-bearing rules, verbatim:

> You are an **adversarial verifier** … Your job is to **refute** that the objective has been met. **Default to `refuted: true` if uncertain.**
> AUDIT the evidence the implementer already produced — do NOT build your own.
> NO TEST THEATER … never hard-code the expected value … A dishonest or absent test proves nothing.
> On a re-verification round … **the bar does NOT rise between rounds.**

**The evidence packet** (evidence.rs:6–22) is the judge's typed input contract: `OBJECTIVE` + `CHANGES_FILE` (truncated unified diff vs the goal-creation baseline commit — a scope/honesty anchor, not sole proof) + `CHANGED_FILES` (complete list, cap 300 — skeptics read *live* files) + `PLAN_FILE` + **`PLAN_CHANGES` (baseline→current plan diff — catches acceptance criteria quietly weakened by the worker)** + `FINAL_RESPONSE`.

**Exit/status vocabulary** (goal_tracker.rs:64–87): `Active | UserPaused | BackOffPaused` (3 consecutive non-success turns, or classifier run cap `GOAL_CLASSIFIER_MAX_RUNS_DEFAULT = 10`) `| NoProgressPaused` (**stall fingerprint**: the judge's reported gap set hashes identically twice, threshold 2) `| InfraPaused | Blocked` (`blocked_reason` after a streak, or a contradiction/unverifiable-only gap set) `| BudgetLimited | Complete`. Every pause retains state for resume — budget exhaustion is a checkpoint, not a tombstone. On process restart, Active → UserPaused (subagents don't survive) and in-flight phases → Idle.

**The stop detector** (goal_stop_detector.rs:40–88) is a *deterministic* regex panel over the final assistant paragraph — `unable_to_proceed`, `giving_up`, `stopping_here`, `check_back_later`, `ready_for_review`, `please_deflection` ("Please run/install…"), `commit_push_pr` — which, combined with pending todos, switches the continuation nudge to a bail-preface. A zero-token machine classifier in front of the expensive fuzzy panel.

**Continuation** is in-turn injection: a synthetic user message with the sentinel `Goal NOT complete — continue working. Next step:` (mined from the plan's first unchecked item, goal_next_step.rs), optionally carrying a one-shot strategist recommendation.

## 3. Memory & compaction

- **Auto-compact**: threshold percent over the model's context window (`exceeds_threshold`, bytes/4 estimation in `xai-token-estimation`); checked pre-sample, on sampler context-overflow errors (`CompactAndResubmit` → `continue`), and post-tools (`check_preflight_overflow`). A **two-pass** scheme (two_pass.rs): pass 1 summarizes ~95% of history by token weight into NOTE₁ (cap 12k chars), pass 2 rewrites NOTE₁ + the ~5% tail into the successor-visible NOTE₂; splits snap to tool-call/result boundaries (pairing invariant again).
- **Compaction provenance is excellent**: `compaction_checkpoints/{id}.json` persists the *exact* compacted history (`CompactionCheckpointFile { compacted_history: Vec<ConversationItem>, schema_version, … }`), `compaction_requests/{id}.json` persists the exact summarizer request+response for offline A/B, and a pointer event lands in the update log. Pre-compaction state is fully reconstructible.
- **Tool-result pruning** upstream of compaction: soft head/tail trim (default 4,000 chars), hard clear after N turns (keep last 3) — per-result budgets before episodic summarization, the Claude Code graduated pattern.
- **Post-compaction system prompt** is a 2-line constant (`COMPACT_SYSTEM_PROMPT`, prompt/template.rs:55–56) — they *shrink* the system prompt after compaction rather than re-render the full one.
- **Cross-session memory** (`xai-grok-memory`, flag-gated): curated `MEMORY.md` (global + per-workspace) + dated session logs + sqlite-vec embeddings with MMR search. Fold cadence: **idle flush** (timer in the session actor's select loop writes conversation→session log when new messages exist) and **dream** (periodic model-driven consolidation of MEMORY.md — an Observer/Reflector split on a timer). First-turn `<memory-context>` injection; skipped when already present "to preserve prompt cache".
- **Image budget**: chat-state emits `ImageBudget` events and evicts inline images against a byte budget — the fold owns non-text content (the exact pi #5369 failure, handled).

## 4. Tool system

- **Typed trait** (`xai-tool-runtime/src/tool.rs`): `type Args: Deserialize + JsonSchema`, `type Output: Serialize + ToolOutput`, `execute() → ToolStream` (`[Progress*] Terminal(Result)`), `capabilities()`, `should_list(ctx)`. Schemas via schemars; lenient deserializers accept `"80"` for `80`.
- **Three namespaces, vendored competitors**: `GrokBuild:` originals (~30+), plus in-tree source ports of **openai/codex** (`apply_patch` + its patch grammar, `read_file`, `list_dir`, `grep_files`) and **sst/opencode** (`bash`, `edit`, `write`, `read`, `grep`, `glob`, `todowrite`, `skill`) — see `xai-grok-tools/THIRD_PARTY_NOTICES.md`. **Presets** (`grok-build`, `codex`, `opencode`, `explore`, `plan`, …) select the loadout; client-facing names are remapped at preset build (`run_terminal_cmd` → `run_terminal_command`, param `is_background` → `background`).
- **Prompt/tool indirection**: tool descriptions and the system prompt are MiniJinja templates referencing tools *by kind* — `${{ tools.by_kind.read }}` renders the actual registered name, and `${%- if tools.by_kind.plan %}` sections drop out when the tool is absent (templates/prompt.md:19). The prose adapts to the toolkit mechanically — a string-typed shadow of interpolation-as-dependency.
- **Output discipline**: `DEFAULT_TOOL_OUTPUT_BYTES = 40_000` (~10k tokens); bash 20–30k chars; truncated results carry a **disk pointer** (`[truncated … full output at: <file>]`); web_fetch overflows to session artifacts; MCP has its own cap (default 20k). Long lines soft-wrap at 2,000 chars so content survives the byte budget.
- **Terminal**: PTY sessions via `ptyctl` (alacritty_terminal-based headless PTY with HTTP control); background tasks with a registry, manifests, `get/wait/kill_command_or_subagent` lifecycle tools; auto-background on foreground timeout; a `monitor` tool streams each stdout line back as a chat notification.
- **Edit feedback**: after a successful `search_replace`, LSP diagnostics are drained (500ms) and appended to the tool result as a `<system-reminder>` — environment feedback riding the tool result (OpenCode's pattern).
- **Workspace seam**: `WorkspaceOps::Local | Proxy` — in proxy mode *all* tools execute on a remote workspace server over WebSocket RPC ("the shell has zero local dispatch"); FS/search/git/hunks/code-nav/worktrees are RPC methods. Execution location is a seam, not a rewrite.
- **Code intelligence**: `xai-codebase-graph` (tree-sitter symbol index, goto-def/refs, incremental reindex) + an `lsp` tool; structural, not embedding-based.

## 5. Subagents

- **Depth-capped composition**: the `task`/`spawn_subagent` tool spawns a full `SessionActor` with `startup_hints.is_subagent`; **`MAX_SUBAGENT_DEPTH = 1`** — subagents cannot spawn subagents. Roles/personas resolve through a pure crate (`xai-grok-subagent-resolution`): explicit override > role > persona > parent, with **fail-open retry** (an explicit model override that fails once retries inheriting the parent's model).
- **Forked context normalization** (subagent-resolution/context.rs:37–110): parent history collapses into one `<background_context>` user message — ≤3 complete turns verbatim, else summarize-early + keep last 3 verbatim; the task prompt arrives separately as the final user message (recency). A middle path between summary-return isolation and Codex's full-history forks.
- **Completion as auto-wake**: background subagent completion injects a synthetic prompt tagged `SyntheticReason::SubagentCompleted` (results as steers at a boundary — exactly our §2.8a completion-steer shape); usage rolls up into parent ledgers (`RecordSubagentUsage`, with an explicit incomplete-attribution path).
- **Cancellation is caller-scoped**: Ctrl+C cancels subagents (`cancel_subagents: true`); **send-now steering deliberately does not** — the parent turn dies, children keep running. Goal-verifier subagent completions arriving mid-turn are *deferred* so they can't race the parent's sampler (`DrainPurpose`).
- **Crash reconcile**: on session replay, an unpaired `subagent_spawned` event synthesizes `SubagentFinished { status: "cancelled", error: "interrupted by process restart" }` (storage/mod.rs:1017–1056) — the pairing invariant applied to child lifecycles.

## 6. Sessions / state / durability

- **File-first, three representations**: per-session dir `~/.grok/sessions/{urlencoded_cwd}/{session_id}/` holds **`updates.jsonl`** (append-only log of every ACP/xAI session update — the UI/event truth), **`chat_history.jsonl`** (the materialized model conversation — *replaced wholesale* on compaction), and **`summary.json`** (mutable metadata: title, model, fork lineage, git HEAD, `chat_format_version: 1`), plus ~10 side files (plan, signals, goal state, rewind points, prompts, compaction checkpoints/requests/segments).
- **No write-ahead journal of effects.** Persistence is an actor draining a message queue concurrently with the turn; appends heal torn tails by prepending `\n`; `Flush`/`FlushAndAck` barriers exist (used e.g. for user-message persist acks) and an opt-in durable append does fsync + parent-dir sync — but there is no "journal intent before the model/tool call" ordering. A crash mid-turn loses whatever didn't flush; recovery = repair dangling calls + reconcile orphan subagents.
- **Resume = snapshot + replay, split by consumer**: `load_light` hydrates `chat_history.jsonl` + side state for the *model*, then streams `updates.jsonl` to the *client* with cursor support for incremental reconnect; live notifications are buffered during an in-flight `session/load` so replay never interleaves with live (the reconnect race, handled). The process-global event-id counter is re-seeded from the max persisted id so live events stay monotonic after replay.
- **Forks are directory copies** with `parent_session_id`/`forked_at`/`session_kind` (`"fork" | "worktree" | "subagent_resume"`) and optional truncation to a prompt index; rewinds mark dead branches in the update log, filtered on replay.
- **Workspace undo is a parallel stack**: `RewindPoint` file snapshots (before+after) per prompt index in `rewind_points.jsonl`; optional hunk-tracker deltas and git HEAD/index capture; optional durable checkpoint mirror under `<cwd>/.grok/rewind-checkpoints/` (cap 64). Plus `xai-fast-worktree` (CoW/git worktrees, SQLite registry) and a **pre-warmed worktree pool** that is built, marked "future-use", and unwired — a fossil of a parallel-agents ambition.
- **Leader daemon**: one agent process per machine (`~/.grok/leader.sock`, protocol v1), multiplexing TUI/IDE/headless clients with per-client capability injection (`yolo_mode`, `fs_read/write`, …) — one brain, many surfaces, with version-aware eviction. `active_sessions.json` (PID-liveness lock file) answers "was a TUI mid-session when the process died".

## 7. Async vs sync

Everything is actors + channels: session actor ↔ chat-state actor ↔ sampler actor, commands with oneshot replies, events fan out as ACP `session/update` notifications. The **ACP protocol** (JSON-RPC over stdio, xai-acp-lib for framing) is the one wire: TUI, IDE embedding, and headless all speak it; `session/request_permission` is the approval reverse-request; `x.ai/*` extension methods cover fs/git/worktree/fork/rewind/hooks/plugins/MCP. Blocking reverse-requests are RAII-tracked (`PendingKind { Permission, Question, PlanApproval }` with first-answer-wins and park-keeps-session-resident semantics). Headless `grok -p` emits plain/json/**streaming-json** (JSONL events). A 5s stream-drain barrier orders tool events after model-stream events (sampler_turn.rs:860–913).

## 8. Pluggability

- **Hooks** (`xai-grok-hooks`): Claude- and Cursor-compatible JSON configs; 13 events; **only `PreToolUse` blocks** (`{"decision":"allow"|"deny"}` on stdout or exit code 2); subprocess (JSON envelope on stdin, 5s timeout, 64KB caps) or HTTPS; fail-open except explicit deny; project hooks gated by folder trust.
- **Plugins**: filesystem packages (skills/, commands/, agents/, hooks/, .mcp.json, .lsp.json) — no plugin VM; enable loads content, **trust** activates hooks+MCP+LSP; git-backed marketplace with optional SHA pinning.
- **Skills**: `SKILL.md` progressive disclosure — budget-truncated name+description index in the first user message, body on demand via the `skill` tool/slash command/read-by-path; **mid-session discovery** (a reminder announces `SKILL.md` files found near tool-touched paths, telling the model to read them); compat scans of `.claude/skills`, `.cursor/skills`.
- **MCP**: stdio/HTTP/SSE + OAuth (DCR, token store); tools are **not dumped into the schema** — model-facing meta-tools `search_tool` (discover) and `use_tool` (invoke `server__tool`) do progressive tool disclosure, with the native-registration path as a per-tool opt-in.
- **Config**: layered TOML — `/etc/grok/managed_config.toml` → `$GROK_HOME` managed → user `config.toml` → **Ed25519-signed `requirements.toml`** (cloud-synced enterprise policy) → macOS MDM; project `.grok/config.toml` contributes a restricted subset. Plus `[compat.cursor|claude|codex]` toggles and a full **Claude Code settings importer** (settings/MCP/hooks/permissions → Grok TOML, SHA-tracked so prompts don't repeat).
- **What's hardcoded**: the loop shape, the goal harness's role wiring and verdict aggregation, compaction's two-pass algebra, the pairing repair, the permission lattice, session file formats. The `xai-agent-lifecycle` hook crate states the doctrine: contributors get data-only inputs and capabilities injected at install — "**they never own loop control**."

## 9. Human-in-the-loop

- **Three permission layers**: UI mode (`Ask | AlwaysApprove | Auto`), agent-definition mode (Claude-compat `default|acceptEdits|auto|dontAsk|bypassPermissions|plan`), and a rule DSL (`Bash(...)`, `Edit(...)`, `WebFetch(...)`, `MCPTool(...)` allow/deny patterns). The engine is ~15k LOC (manager/resolution/auto_mode/prompter).
- **Approvals are amendments**: `PromptOutcome` includes `AllowAlways`, `AllowEditsForSession`, `AllowAlwaysBashCommand(cmd)`, `AllowAlwaysDomain`, `AllowAlwaysMcpTool/Server`, `RejectAlwaysBashCommand` — one human answer creates a durable rule (persistence gated by a remote `remember_tool_approvals` setting). Codex's ratchet, independently converged.
- **Denial is a model-visible failed result**: reject/policy-deny → ACP `ToolCallUpdate(Failed)` + `ConversationItem::tool_result(id, reason)` (tool_calls.rs:2567–2584); sibling parallel calls get "cancelled due to earlier permission rejection". The confabulation trap is closed.
- **Auto mode has an LLM classifier**: `auto_mode` wires an LLM-side permission query (`auto_classifier_*` decision reasons) — a Guardian-shaped judge at the capability boundary, as a *mode* rather than a layer.
- **Sandbox** (`xai-grok-sandbox`): process-lifetime Landlock (Linux) / Seatbelt (macOS) via nono, profiles (`workspace | devbox | read-only | strict | off` + TOML custom), child-process network denial via seccomp, bwrap re-exec for deny-path carve-outs. Apply is irreversible; **failure degrades to unsandboxed** (soft-fail) — and an active sandbox *auto-allows* bash (`sandbox_auto`), trading prompts for kernel enforcement. No Codex-style per-command retry-unsandboxed loop.
- **Plan mode**: read-only session mode (write tools blocked except the plan file), exit requires client approval — a durable park (`PendingKind::PlanApproval`) that keeps the session resident.

## 10. Provider abstraction

`xai-grok-sampler` supports **three wire APIs** — `ChatCompletions`, `Responses`, Anthropic `Messages` (sampling-types:1013–1020) — behind one `SamplingEvent` stream and one actor (contrast Codex, which deleted all but Responses). Retry policy: 15 attempts, 30s backoff cap, `x-should-retry` header honored, 413/image errors strip images and retry once; 401 handled shell-side with token refresh. **Prefix-cache discipline is explicit**: `Reasoning` and `BackendToolCall` items are persisted as ordered siblings *specifically* for byte-stable prefixes ("server-side prefix KV-cache hits"), and Anthropic gets `cache_control: ephemeral` on the last system block. Models come from an embedded catalog (default/web_search/image_description/session_summary slots) + custom `[model.<id>]` endpoints; hosted tools (server-side web search) are typed request fields gated per-model. `doom_loop` modules detect repetition at both the sampler and tool-dispatch levels.

## 11. Integration

- **Headless** `grok -p` / `--prompt-file`: plain/json/streaming-JSONL out; `--yolo`, `--tools` allowlists, `--max-turns`, `--rules` (append `<human_rules>`), `--system-prompt-override`; exit codes 0/1/130/143.
- **ACP** for editors (Zed et al.), the same server the TUI uses via the leader.
- **Workspace proxy** for remote/cloud execution (§4).
- **Prompt transparency**: `grok prompt --section template` prints the (decrypted) system prompt sections; the TUI's own user-guide markdown is a load-bearing runtime artifact the model is told to read (`<user_guide>` section, templates/prompt.md:43–45 — pi's "docs are runtime artifacts" mechanic).

---

## Judgments

**What they got right**

1. **Verification as an adversarial panel with a typed evidence contract.** Default-refute, audit-don't-rebuild, no-test-theater, bar-does-not-rise, majority-refute quorum with a persistent gatekeeper, and an evidence packet that includes the **plan diff** so weakened acceptance criteria are caught. This is the strongest shipped answer to "the worker's claim of done-ness is not a signal" in any surveyed harness — Codex's completion audit is one judge with a prompt; this is N judges with a data contract.
2. **Failure polarity as a per-role design decision.** Planner fail-closed, strategist/summarizer fail-open, verifier-infra fail-open-Achieved — each polarity argued from consequences. Most harnesses have one global disposition.
3. **`PlanGuard`** — the strategist can *write* strategy but its plan edits are mechanically reverted. Write-scope partitioning on externalized state (Ralph's spec discipline) enforced by the harness, not by prose.
4. **The stop-detector-before-the-panel shape**: a zero-token regex classifier flavors the nudge and gates escalation to the expensive fuzzy judges. Graduated verification, shipped.
5. **Stall fingerprints**: stagnation = the judge's gap set hashing identically across rounds. A concrete, cheap, judge-integrated no-progress detector (better than diffing folds).
6. **Compaction provenance**: exact compacted history + exact summarizer request/response persisted per compaction. You can replay, A/B, and audit the fold offline.
7. **Approvals-as-amendments + denial-as-failed-result** — the Codex/OpenCode lessons, independently converged, plus per-domain and per-MCP-server grants.
8. **MCP meta-tools** (`search_tool`/`use_tool`): big catalogs stay out of the schema; discovery is a tool call. Progressive disclosure applied to tools, not just skills.
9. **Tool-name indirection in prompts** (`${{ tools.by_kind.* }}` + conditional sections): prose that mechanically tracks the toolkit — the untyped cousin of our interpolation-as-dependency, and evidence the need is real.
10. **Interop as strategy**: vendored codex/opencode tool ports, Claude/Cursor hooks/skills/rules compat, a Claude settings importer. They treat *tools and config formats as commodity* and compete on the harness.

**What's weak / regretted (evidence in-tree)**

1. **State is scattered**: mutable `summary.json` + two JSONL logs + ~10 side JSON files + goal state + rewind points + checkpoint stores + an FTS index — at least four consistency domains reconciled ad hoc on resume (subagent reconcile, torn-tail healing, event-id re-seeding). The `updates.jsonl` (UI truth) vs `chat_history.jsonl` (model truth, *replaced* on compaction) split is the two-transcripts anti-pattern; the compaction checkpoints are the compensating machinery its authors had to build.
2. **No write-ahead ordering**: persistence races the turn; durability of "what the world already saw" depends on flush timing. They ship the repair machinery instead of the ordering guarantee.
3. **The goal harness is welded in, not composed**: planner/strategist/skeptic wiring, quorum rules, pause taxonomy, and continuation prose are hardcoded in ~18k LOC of session code. There is no seam to swap the verifier policy or reuse the panel outside `/goal` (contrast Codex shipping /goal as an extension). `goal_classifier.rs` at 6.6k lines is the god-file tell.
4. **Loop-exit gates accreted**: TodoGate + laziness classifier + completion requirement + goal continuation + structured-output enforcement are five separately-configured "don't stop yet" mechanisms with separate caps, each patched in where the last one didn't reach (the same accretion disease as Mastra's five continuation mechanisms).
5. **Sandbox fail-open**: apply failure silently degrades to unsandboxed, and sandbox presence *auto-approves* bash — two compounding weakenings; an attacker who can break sandbox apply gets auto-approved execution.
6. **Prompt XOR obfuscation** with in-repo seeds and in-repo plaintext templates: pure theater, and a mild signal that prompts are viewed as IP rather than versioned engineering assets (no content-addressing, no hash regression story; the tests only check staleness of the obfuscated bytes).
7. **Name/reality drift**: `xai-sqlite-journal` journals nothing; `goal_orchestrator.rs` orchestrates nothing; `xai-grok-tools-api` is a protobuf wire, not the tool API. Archaeology cost for every reader.

---

## Insights for Alchemy

1. **The check slot should support a panel, and the panel is a Layer, not a term.** Grok's quorum (N cold skeptics + persistent gatekeeper, majority-refute, default-refute-if-uncertain) is an *aggregation policy over independent judge arrows* — in our algebra, a `Check` implementation that fans out one judge agent N times (fresh context each) plus a session-carrying gatekeeper, folding verdicts. `AI.check(Judge)` names *who*; the panel/quorum is physics behind the check slot (kernel policy or a check-combinator Layer). No new term kind needed — but the design should say the check arrow may be a composite. [goal_classifier.rs:1–10, 1009–1045]
2. **Type the judge's input as an evidence packet, and include the spec diff.** Our `CheckInput` is `{ workItem, haltProse, claim }` (src/AI/Check.ts:5–12) — the live-test lesson ("the judge needs the mandate") is in. Grok goes further: the packet carries the *work-product diff vs a baseline captured at run creation* and the **plan/spec diff** so the judge can detect goalpost-moving by the worker. For Fix-shaped rings: capture a baseline ref at dispatch, hand the check `{ workItem, haltProse, claim, workProductRef, specDelta }`. The spec-drift check is cheap and closes a gaming channel our current contract can't see.
3. **"The bar does not rise between rounds" is a missing sentence in our default judge policy.** Codex taught evidence-based completion audits; Grok adds the symmetric anti-ratchet: re-verification must not invent new requirements, or off-goal feedback loops never converge. One line in the default check prompt (KernelPrompts/kernel assets), plus a regression fixture where a second round with unchanged evidence must return the same verdict.
4. **Ship the deterministic bail-detector as a `MachineCheck` in front of fuzzy grading.** Our check slot already takes arrows (src/AI/Check.ts:29). Grok's regex panel over the final assistant paragraph (stopping-here / ready-for-review / please-run deflections + open todos) is exactly the cheap first rung of §2.9's graduated verification — and it grades *quiescent non-claim boundaries*, our named not-yet gap. Port the pattern list nearly verbatim.
5. **Stall = fingerprint equality over judge gaps, not fold deltas.** Our `AI.budget({ stall })` promises a no-progress ceiling but leaves detection as "kernel policy" (design §1.2.2). Grok's mechanism is concrete and better than diffing folds: hash the check's off-goal gap set; identical fingerprint twice ⇒ stall. It couples stagnation detection to the verifier (who already articulates *what's missing*) instead of to state deltas (which churn cosmetically). Adopt as the default `stall` detector; `BudgetExceeded{limit:"stall"}` carries the repeated fingerprint. [goal_tracker.rs `NoProgressPaused`, threshold 2]
6. **Pause taxonomy validates and extends our resumable-park doctrine.** `BackOffPaused / NoProgressPaused / InfraPaused / Blocked / BudgetLimited` all retain state for resume; only `Complete` is terminal. Our `BudgetExceeded` (resumeHint) and `Refused` (observed count) match; the gap is **InfraPaused** — a typed "the harness failed, not the work" park distinct from both. Worth a design note: harness-failure during a run should park-with-reason, never surface as `Refused` or budget noise (our check-failed verdict covers the judge; this is the same rule for the worker's substrate).
7. **Failure polarity is a per-role, declare-it-explicitly decision.** Planner fail-closed / strategist fail-open / verifier-infra **fail-open-Achieved** (don't strand an interactive user). That last one is right for a TUI and *wrong* for an autonomous org ring (a broken judge must park, never accept — our check-failed rule). The insight to keep: every positional arrow (check, fold, planner-shaped delegates) needs a declared failure disposition, and interactive vs autonomous deployments legitimately choose differently — which in our model is a Layer choice per ring, not a global constant.
8. **PlanGuard = write-scope partitioning enforced by the harness.** §8.4 flagged "partitioned write permissions on externalized state" as expressible-but-undesigned. Grok ships it: the strategist's mandate is HOW-not-WHAT, enforced by mechanically reverting its plan-file writes. In our model this is per-agent tool physics (the Strategist's `WriteFile` Layer scoped to `strategy.md`), which is *stronger* (typed, not revert-after) — but the revert-after pattern is the right fallback where physics can't scope (shared repo checkouts). Note it in the sandbox seam.
9. **Synthetic-input provenance should be typed on the message.** `UserItem.synthetic_reason` (Interjection/AutoContinue/SubagentCompleted/GoalClassifierNudge/…) gives every injected message a model-visible *and* machine-auditable origin tag. Our steers/completion-steers/nags are kernel prose today; the Trace event carries `cause`, but the *message* doesn't carry its kind. Adopt: kernel-injected inputs carry a typed `origin` in the Trace payload (and render distinctly), so autoresearch can cluster "how often do rings run on nags vs real input" without prose-sniffing.
10. **Two truths (UI log vs model history) is the disease; provenance checkpoints are the symptom-relief.** Grok persists `updates.jsonl` (replayable, cursored — their serving tier is *right*) and separately materializes+replaces `chat_history.jsonl`, then needs checkpoint files to reconstruct pre-compaction state. Our Trace-is-truth + derived-Prompt design (§2.7) avoids the split; what to *steal* is the per-compaction artifact: persist the summarizer's exact request+response as durable events (`ContextCompacted` payload), so folds are offline-auditable and A/B-able — grok proves the operational value.
11. **Steering delivery points, confirmed again; queue promotion is new.** Drain at loop-top and before-Completed = pi's two points (our boundary promotion is coarser and fine). The new mechanic: *promoting a queued prompt into a steer* atomically (dequeue + interject) — our ledger should support re-classing an admission (queued work item → steer of the active run) as one transactional move keyed by delivery id; the org front door will want it ("actually, fold this into the running fix").
12. **Depth-1 subagents + fail-open role overrides are a pragmatic floor.** Grok caps delegation depth at 1 and retries failed model overrides by inheriting the parent's model. Our depth story is Layer-graph structure (typed, arbitrary); the fail-open override retry is worth copying into delegation-tool physics: a delegate whose specific model Layer fails at spawn should fall back to the ring default with a Trace note, not kill the parent's turn.
13. **MCP meta-tools validate compiled-toolkit minimalism.** Keeping large tool catalogs out of the schema behind `search_tool`/`use_tool` is the tool-side twin of skills-as-index. For us: a charter that references an MCP-backed capability package should compile to a *discovery* tool + an *invoke* tool rather than N schema entries — a `ToolMode`-adjacent presentation choice the kernel seam should permit per term.
14. **Contradiction with our design, resolved in our favor again — but note the compensations.** Like Codex, no pure step machine, no deterministic replay; mutable actor state with repair-at-write-boundaries; persistence racing the turn. It works at scale because of four compensators: pairing repair, subagent reconcile, torn-tail healing, id re-seeding. That's the floor tier of our conformance suite implemented as four hand-rolled patches — each one is a test case our `resume + repair` floor must pass generically.
15. **The goal harness is what our Process term *is*, welded.** Planner→`AI.fold`-seeded plan artifact; continuation→idle-wake/nag; `update_goal`→halt-as-tool (+ `blocked_reason`→`Refused` claim path); skeptic panel→`AI.check`; strategist→a check-feedback post-processor; statuses→our `Err`/park vocabulary; budget→`AI.budget` Layer. Every component maps — and none of theirs is reusable outside `/goal` because none is a term or a Layer. This is the strongest single validation yet of factoring the loop's control expressions out of the harness: xAI built our Process semantics, 18k lines deep, exactly once, non-compositionally.

**Couldn't determine / honesty notes**: line numbers are approximate (subagent-surveyed, spot-verified; the vendored tree is the reference). I did not run `grok` or tokenize rendered prompts (~1k-token base / ~5k apply-patch estimates are chars/4). The scheduler tools (`scheduler_create/…`), `deploy_app`, voice pipeline, telemetry/trace_classifier internals, and the relay/remote modules were surveyed shallowly. `two_pass` compaction sampling details and the hashline toolset were not traced end-to-end. The worktree pool is explicitly unwired ("no callers today") — treated as a fossil, not a feature. Grok Build's docs live in-repo (`crates/codegen/xai-grok-pager/docs/user-guide/`, 24 files) and are authoritative for user-facing behavior.
