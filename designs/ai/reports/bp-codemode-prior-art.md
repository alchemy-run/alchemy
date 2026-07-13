# Codemode Prior Art: A Source-Level Survey of Code Execution in Agent Systems

> Follow-up to `bp-kernel-layers-codemode-skills.md`. Deep dive into the vendored repos (`.vendor/`)
> plus targeted web research, per the owner's request: "spawn a subagent to just go through relevant
> code bases and incorporate insights into our study."
>
> Written for the sibling agent revising the kernel report: every finding ends in an implication
> (adopt / reject / modify).

## Verdict

Codemode is no longer speculative — **every serious agent runtime now ships it or is actively
building it**, and they have converged on a remarkably consistent shape that validates our proposed
design almost point-for-point:

1. **One model-facing tool** (`execute` / `exec` / `Workflow` / `codemode`) whose single argument is
   raw source code. Everyone does this. Nobody exposes N tools plus an eval tool as peers — tools
   that enter the sandbox are *hidden* from the model's direct tool list (opencode's "deferred"
   tools, codex's `CodeModeOnly`, OpenClaw's exec/wait-only surface).
2. **The `ToolMode` seam we proposed literally exists in Codex**: `enum ToolMode { Direct, CodeMode,
   CodeModeOnly }` — and it is **per-model server metadata**, not a host config knob. OpenAI decides
   per model whether it tool-calls directly, gets code-mode alongside direct tools, or code-mode only.
3. **Durability-by-re-execution with a memoized call ledger is shipping**, not just our idea:
   Vercel's `experimental-ai-sdk-code-mode` (used by eve) persists a signed continuation
   `{ code, determinism, ledger, nonce, signature }` and resumes by replaying the program with
   completed calls served from the ledger. This is exactly our "codemode program as durable workflow,
   tool calls as memoized Activities" design, minus Effect's engine support (which makes ours stronger).
4. **Nobody stores or exposes an AST.** The AST is a transient parsing artifact inside the evaluator
   in every system. What UIs see is (a) the code string itself in the tool-call args and (b) a stream
   of nested-tool-call lifecycle events. Our proposed AST pass for call-graph visualization would be
   genuinely novel — and should therefore be a *derived view over stored code + trace*, not a stored
   artifact or a kernel obligation.
5. The main axis where systems genuinely differ is the **execution substrate**, and it is a spectrum
   of confinement vs. fidelity: owned tree-walking interpreter (opencode) → QuickJS-wasm
   (Vercel/eve, OpenClaw) → V8 isolate (Codex, Cloudflare) → container/microVM (Anthropic's hosted
   tool, Vercel Sandbox). Substrate choice is orthogonal to everything else and all systems treat it
   as pluggable — which confirms our `CodeExecutor` seam.

## Comparison table

| System | Substrate | Tool exposure to code | Durability / suspension | Confinement | UI observability | Maturity |
|---|---|---|---|---|---|---|
| **opencode** (dev branch, shipped behind flag) | Owned tree-walking interpreter over acorn AST; TS transpiled away | `tools.<server>.<tool>()` tree from MCP tools; TS signatures rendered from JSON Schema; `$codemode.search` | None by design ("hosts own durable pause/resume"); abort = whole program cancelled | Strongest: no eval, no host globals, plain-JSON data boundary, fixed nesting/concurrency caps | Live per-call status streamed to TUI via `ctx.metadata`; attachments channel for files | Shipped, experimental flag |
| **Codex** (OpenAI, Rust) | **V8 isolate** (rusty_v8), fresh isolate per exec, async module | Global `tools.*` + `ALL_TOOLS`; TS declarations from JSON Schema; MCP `CallToolResult<T>` typing | **Cells**: `exec` yields after `yield_time_ms`, keeps running server-side; `wait` resumes/streams; `store`/`load` KV across execs; no crash durability | Isolate: no Node, no fs, no network, no console; nested calls dispatched back to host router | Nested calls route through the normal tool router (normal tool events); `notify()` injects output mid-run | Deep: 4 crates, protocol, remote (process-owned) sessions, per-model ToolMode |
| **eve** (Vercel) + `experimental-ai-sdk-code-mode` | **QuickJS** (wasm, memory/stack limits), worker-hosted | Only `tools.<subagentName>` bridges (subagents only, root-only, non-recursive); cap = `maxSubagents` (default 100) | **Best-in-class**: interrupt → HMAC-signed continuation `{code, determinism, ledger}`; resume = deterministic **re-execution** with ledger replay; parks across restarts, 365-day max age | Allowlist-only: no fetch (policy-gated), no env, no host realm | `onNestedToolCall/Result` hooks project onto the parent event stream as `subagent.called/completed`; `replayed` flag suppresses duplicate events | Shipped, experimental |
| **Cloudflare** `@cloudflare/codemode` + Think | **V8 isolate via Worker Loader** ("Dynamic Workers", ms startup) | `codemode.toolName()` via Proxy → Workers RPC back to host; TS defs generated from tools | None in codemode itself; **`@cloudflare/dynamic-workflows`** runs model-authored `run(event, step)` as a first-class durable Workflow (step persistence, sleep, waitForEvent) | `globalOutbound: null` default (no network); capability-by-binding | Console output captured; no approval support yet (documented gap) | Shipped (preview); Think = opinionated harness on top |
| **OpenClaw** | **QuickJS-WASI** | `tools`, `ALL_TOOLS`, hidden run-scoped catalog; MCP under `MCP.*` namespace | **VM snapshot/restore**: on suspension, serialized QuickJS state saved (size-capped, TTL 900s); `wait` restores snapshot, delivers results | Sandboxed wasm VM; nested calls go through normal policy/approvals/hooks | exec/wait statuses; nested calls audited via normal executor path | Shipped, experimental, off by default |
| **Mastra** | — none | — | — | — | — | No codemode; provider-executed code tools passed through |
| **pi** | — none (bash-as-universal-tool stance) | — | — | OS-level sandbox for bash (extension, `sandbox-exec`/bubblewrap) | — | Deliberately absent |
| **AI SDK** (`.vendor/ai`) | `Experimental_SandboxSession` = bash+fs abstraction (Vercel Sandbox microVM / just-bash); code-mode lives in the **external** `experimental-ai-sdk-code-mode` pkg | n/a in-repo | n/a | n/a | n/a | Sandbox = harness substrate; codemode external |
| **flue** | — none itself; uses `@cloudflare/codemode` + `@cloudflare/shell` when deployed on Cloudflare | — | fibers via Agents SDK on CF | — | — | Consumer of Cloudflare's stack |
| **Anthropic** (hosted) | Managed Python container (`code_execution_20260120`) | Tools opt in via `allowed_callers: ["code_execution_…"]`; exposed as async Python fns | Container pauses on tool call → API returns `tool_use` → host answers → container resumes | Anthropic-managed | Tool calls surface as normal API tool_use blocks | GA-track; +11% on agentic search, −24% input tokens (their numbers) |
| **smolagents** | `LocalPythonExecutor`: AST-walking Python interpreter (same family as opencode's), or E2B/Docker | Python functions injected into namespace | None | AST interpreter w/ import allowlist | Steps logged | Shipped since 2024, the original CodeAgent |

---

## 1. opencode — codemode is wired in, shipped, and has a written doctrine

The prior study covered the interpreter internals (`packages/codemode`). The new findings are about
**integration**, which the prior report could not confirm. It is integrated, on the `dev` branch,
behind `OPENCODE_EXPERIMENTAL_CODE_MODE`.

### 1a. The wiring: one `execute` tool over the MCP catalog

The adapter is `packages/opencode/src/tool/code-mode.ts`. The model-facing tool is named `execute`
with a single `code` param:

```12:20:.vendor/opencode/packages/opencode/src/tool/code-mode.ts
export const CODE_MODE_TOOL = "execute"

const DESCRIPTION = "Run a confined orchestration script with access to connected MCP tools."

export const Parameters = Schema.Struct({
  code: Schema.String.annotate({
    description: "Script body executed by the confined interpreter.",
  }),
})
```

Registration is a dynamic import gated on the runtime flag
(`packages/opencode/src/tool/registry.ts:113-114`; flag defined in
`src/effect/runtime-flags.ts:48`). Only **MCP tools** enter the sandbox on the dev branch — built-in
tools (read/edit/bash) stay direct. Tools are grouped by server into a two-level tree
(`groupByServer`, code-mode.ts:39-56) and the whole catalog is rendered into the `execute` tool's
*description* via `CodeMode.make(...).instructions()` (code-mode.ts:58-65, registry.ts:300-326) —
the catalog lives in the tool description, not the system prompt.

### 1b. Permissions: per-nested-call, through the normal pipeline

Every nested call inside the program goes through the host's permission ask and plugin hooks — the
sandbox does **not** get pre-authorized blanket access:

```146:169:.vendor/opencode/packages/opencode/src/tool/code-mode.ts
  const result: CallToolResult = yield* Effect.gen(function* () {
    yield* input.ctx.ask({ permission: input.entry.key, metadata: {}, patterns: ["*"], always: ["*"] })
    // Deliberately mirrors McpCatalog.convertTool's transport call so the MCP service stays free of tool-loop concerns.
    return yield* Effect.promise(async () => {
      const raw = await input.entry.tool.client.callTool(
```

`tool.execute.before` / `tool.execute.after` plugin hooks fire per nested call
(code-mode.ts:141-145, 180-184), each nested call gets a synthetic `callID`
(`${ctx.callID}/${n}`, code-mode.ts:227), and an `Effect.withSpan("Tool.execute", …)` carries
tool name / call id / session id (code-mode.ts:170-179). Also note the permission-scoped catalog:
`Permission.visibleTools(mcp.tools(), ruleset)` filters what the *model even sees* per agent
(code-mode.ts:209-212) — catalog visibility and execution authorization are deliberately separate
concerns (codemode.md:102-103).

### 1c. Observability: live streaming of nested-call status to the TUI

The `onToolCallStart` / `onToolCallEnd` hooks push a growing `toolCalls: CallEntry[]` array through
`ctx.metadata(...)` on every transition, so the TUI renders the in-flight program's calls live:

```239:260:.vendor/opencode/packages/opencode/src/tool/code-mode.ts
        const runtime = CodeMode.make({
          tools: toolTree(catalog, callTool),
          onToolCallStart: ({ index, name, input }) =>
            Effect.suspend(() => {
              ...
              calls[index] = { tool: name, status: "running", ...(shown ? { input: shown } : {}) }
              return publish()
            }),
          onToolCallEnd: ({ index, outcome }) =>
            Effect.suspend(() => {
              const current = calls[index]
              if (current) calls[index] = { ...current, status: outcome === "success" ? "completed" : "error" }
              return publish()
            }),
```

Files/binary results never enter the interpreter: MCP image/audio/resource blocks are collected
host-side as attachments and the program only sees `"[2 files attached to the result]"`
(`projectMcpResult`, code-mode.ts:75-116; doctrine at codemode.md:83-84, 139).

### 1d. The design doc: intentional boundaries we should copy verbatim

`packages/codemode/codemode.md` is a living doctrine document. The load-bearing decisions:

- **Interpreter**: TS transpiled away (typescript compiler), acorn parses JS, owned tree-walker
  executes — no `eval` (codemode.md:35-36; `interpreter/runtime.ts:1,136` imports acorn's `parse`;
  the interpreter is 3,465 lines). Package deps are exactly `acorn`, `effect`, `typescript`.
- **Failures are data**: programs return `Result = Success | Failure` with a typed
  `DiagnosticKind` union (`ParseError | UnsupportedSyntax | UnknownTool | InvalidToolInput |
  ... | TimeoutExceeded | ToolFailure | ExecutionFailure`) — `execute` never fails as an Effect;
  host interruption stays Effect interruption (codemode/src/codemode.ts:62-110).
- **Eager, supervised tool promises**: calling a tool starts its Effect immediately on a supervised
  fiber; promises are run-once; ≤ 8 concurrent tool calls; unfinished calls drained before program
  completion (codemode.md:63-67).
- **Budgets are host policy**: `timeoutMs`/`maxToolCalls`/`maxOutputBytes` have *no defaults*
  (codemode.md:69-71).
- **Progressive disclosure**: token-budgeted inline catalog, round-robin across namespaces so one
  big namespace can't starve others, plus an always-callable `$codemode.search` (codemode.md:45-61).
- **Explicitly out of scope**: "Generic permission prompts, authorization policy, **durable
  pause/resume, replay, storage, or exactly-once external side effects. Hosts and tools own those
  concerns.**" (codemode.md:120-124). So opencode's answer to durability is *the same as ours*: it's
  a host/engine concern layered around the interpreter, not an interpreter feature.
- **v2 plan** (codemode.md:86-114): one canonical Tool representation where tools register as
  *direct* or *deferred*; when visible deferred tools exist, core materializes one `execute` tool
  and grouped deferred tools become codemode namespaces. The `execute` settlement is the **single
  model-output bounding boundary** — nested calls keep full intermediate values for in-program
  filtering and are *not* independently bounded/persisted. (Note: `packages/core` in our snapshot
  does not yet contain this — no `codemode` or `deferred` references in `core/src/tool/registry.ts`;
  it's planned, described for a `v2` branch we don't have.)

Dead ends for the record: `packages/script` is release tooling, `packages/function` is their
share-sync Cloudflare Worker — neither is codemode-related. `specs/` contains no codemode documents.

**Implications**:
- **Adopt** the deferred-vs-direct tool split as the semantics of our `ToolMode` seam: codemode is
  not "all tools become code" — some tools stay direct (ours: the ones the model must be able to
  call without writing a program), and the *deferred* set becomes the `tools.*` tree.
- **Adopt** failures-as-data with a typed diagnostic union for our `Eval` tool's output schema.
- **Adopt** the attachments channel: binary never crosses the interpreter boundary.
- **Adopt** per-nested-call permission asks routed through the same machinery as direct calls.
- **Adopt** streaming nested-call metadata as the primary UI surface (for us: Trace rows written
  live, not batch).
- **Confirm** durable pause/resume as an engine concern outside the interpreter — opencode's
  explicit non-goal is exactly what our kernel/Workflow layer supplies.

---

## 2. Codex (OpenAI) — the most production-hardened codemode; `ToolMode` is real

The prior report flagged `code-mode`/`v8-poc` as "worth a follow-up". Settled: this is a
**four-crate, protocol-versioned, deeply integrated subsystem**, not a POC.

### 2a. Crates and substrate

- `codex-rs/v8-poc` — trivial placeholder ("Bazel-wired proof-of-concept crate reserved for future
  V8 experiments", `v8-poc/src/lib.rs:1`), notable only for verifying the **V8 in-process sandbox**
  build flag (`linked_v8_has_sandbox`, lib.rs:17-24).
- `codex-rs/code-mode` — the runtime: V8 isolates (`v8_init.rs`, `runtime/` with module loader,
  timers, globals, value conversion), a **cell actor** per execution
  (`cell_actor/mod.rs:45-93` — spawns the runtime with an mpsc command channel and
  `v8::IsolateHandle` for termination), and session runtimes. Supports **in-process**
  (`InProcessCodeModeSession`) and **process-owned remote** sessions
  (`ProcessOwnedCodeModeSessionProvider`, `remote_session/` + the separate `code-mode-host` crate
  with a stdio codec) — i.e. the interpreter can run in a separate OS process from the agent.
- `codex-rs/code-mode-protocol` — the wire contract: `ExecuteRequest { tool_call_id, enabled_tools,
  source, yield_time_ms, max_output_tokens }`, `RuntimeResponse::{Yielded, Terminated, Result}`,
  `CodeModeNestedToolCall` (protocol/src/runtime.rs:16-89).

### 2b. `ToolMode` — per-model server metadata

```305:309:.vendor/codex/codex-rs/protocol/src/openai_models.rs
pub enum ToolMode {
    Direct,
    CodeMode,
    CodeModeOnly,
}
```

…and it lives on the **model description** (`pub tool_mode: Option<ToolMode>`,
openai_models.rs:427). Tool-spec planning in core consults it: in `CodeMode`/`CodeModeOnly`,
eligible tool specs are *augmented* with a TS declaration and registered as nested tools; in
`CodeModeOnly`, nested-eligible tools are **hidden** from the direct surface entirely
(`core/src/tools/spec_plan.rs:281-286, 430-443`); per-tool opt-out via config
(`is_excluded_from_code_mode`, spec_plan.rs:443-451). The `exec` + `wait` handlers are prepended to
the tool plan (spec_plan.rs:200, 500-509).

### 2c. Tool exposure: TS declarations rendered from JSON Schema, with MCP typing

`code-mode-protocol/src/description.rs` is a complete JSON-Schema→TypeScript renderer
(`render_json_schema_to_typescript`, description.rs:442-705) including property-description
comments, unions, literal types. Every nested tool's description gains:

```379:383:.vendor/codex/codex-rs/code-mode-protocol/src/description.rs
    let declaration = format!(
        "declare const tools: {{ {} }};",
        render_code_mode_tool_declaration(tool_name, input_name, input_type, output_type)
    );
    format!("{description}\n\nexec tool declaration:\n```ts\n{declaration}\n```")
```

MCP tools whose output schema matches `CallToolResult` shape get typed as
`Promise<CallToolResult<TStructured>>` with a shared TS preamble of MCP types emitted once
(description.rs:45-120, 446-485). Deferred tools omitted from the description remain discoverable
via the `ALL_TOOLS` global ("filter `ALL_TOOLS` by `name` and `description`", description.rs:10-11).

### 2d. The exec/wait cell model — partial yields for long programs

From the `exec` tool description template (description.rs:12-35), the model contract is:

- `exec` evaluates raw JS in a **fresh V8 isolate as an async module**; "no Node, no file system,
  no network access, no console".
- A first-line pragma `// @exec: {"yield_time_ms": …, "max_output_tokens": …}` tunes budgets
  (parsed in `parse_exec_source`, description.rs:163-245). Defaults 10s / 10k tokens.
- If the script is still running at the yield deadline, `exec` **yields** with accumulated output
  and a `cell_id`; the model calls `wait { cell_id, yield_time_ms }` to keep waiting, or
  `terminate: true` to kill it (description.rs:36-43). The cell keeps executing server-side
  meanwhile.
- Guest globals: `exit()`, `text()`, `image()`, `generatedImage()`, **`store(key, value)` /
  `load(key)`** (a KV persisting values across `exec` calls *within the session* —
  `cell_actor/mod.rs:50` threads `stored_values` into the runtime), `notify()` (immediately injects
  an extra `custom_tool_call_output` into the live turn — `CoreTurnHost::notify` →
  `Session::inject_if_running`, `core/src/tools/code_mode/delegate.rs:293-310`), `setTimeout`,
  `yield_control()`.

### 2e. Nested calls re-enter the normal tool router

`CodeModeDispatchBroker` (delegate.rs:25-127) is the `CodeModeSessionDelegate`: nested invocations
are queued, gated per-cell, then dispatched through **the ordinary `ToolRouter`/`ToolCallRuntime`**
(`CoreTurnHost::invoke_tool` → `call_nested_tool`, delegate.rs:277-291). So approvals, sandboxing
policy, and event emission for nested calls are the same code paths as direct tool calls — the UI
sees them as tool activity without any codemode-specific event schema.

**No crash durability**: cells are in-memory actors; `store/load` state is session-scoped; a process
restart loses running cells. Durability was clearly out of scope; *responsiveness* (yield/wait) was
the priority.

**Implications**:
- **Adopt (strong confirmation)**: our `ToolMode` seam is literally Codex's architecture, down to
  the name. Add the third variant — `CodeModeOnly` — and consider making the mode a *model
  capability datum* (Codex gets it from the models API) rather than only a Layer config.
- **Adopt**: JSON-Schema→TS-declaration rendering for the catalog (we can go one better: we have
  real Effect Schemas on `AI.Tool`, so signatures can be exact rather than reconstructed).
- **Modify our design**: add a **yield/wait ("cell") protocol** for long codemode programs. Ours
  maps beautifully: the program is an Effect fiber; `yield_time_ms` is a race against
  `Effect.sleep`; `wait` re-attaches to the fiber; partial output = Trace rows already written.
  Codex proves the model can drive this protocol.
- **Consider**: `store`/`load` and `notify` guest helpers. `notify` especially — mid-program
  progress injection into the transcript is cheap for us (it's a Trace row) and valuable for UX.
- **Note**: process-owned remote sessions (isolate crash ≠ agent crash) is smart ops hygiene for a
  V8 substrate; irrelevant for a tree-walking interpreter in-process, relevant if we ever add a V8
  executor.

---

## 3. eve (Vercel) — verified: QuickJS sandbox + signed replay continuations

The prior kernel report could not verify eve's dynamic workflows. **Settled: verified, and it is the
single most relevant durability design for us.**

### 3a. The `Workflow` tool

Opt-in by re-exporting a sentinel as `agent/tools/workflow.ts`
(`docs/guides/dynamic-workflows.md:12-16`). Input schema is one `js` string
(`harness/workflow-sandbox.ts:52-63`). The host surface entering the sandbox is **only
runtime-action tools** — subagents and remote agents; files/shell/skills/connections are excluded
by construction (`createWorkflowHostTools` filters on `tool.runtimeAction !== undefined`,
workflow-sandbox.ts:84-95). Root-only and non-recursive: children never receive the tool
(docs:69). Per-program budget `limits.maxSubagents`, default 100 (docs:54-58).

### 3b. The engine is Vercel's `experimental-ai-sdk-code-mode` npm package

Eve does not implement the sandbox; it wraps `experimental-ai-sdk-code-mode@1.0.16` (vendored
compiled at build time — `shared/workflow-sandbox.ts:2-21`, `package.json:331`). From the package's
published typings (unpkg, v1.0.16 `dist/types.d.ts`):

- **Substrate: QuickJS** with explicit memory/stack limits (types.d.ts ~:619-625), hosted in worker
  threads (`getCodeModeWorkerUrl`, `setMaxWorkers`).
- **Interrupt/continuation**: when a bridged tool needs host work (a subagent run, an approval),
  the sandbox throws a `CodeModeInterrupt` whose `continuation` is:

  > "Opaque continuation state for a code-mode invocation interrupted by nested [calls]" —
  > `{ code, determinism: CodeModeDeterminismState, ledger: CodeModeContinuationLedgerEntry[],
  > nonce, signature (HMAC over the canonical continuation payload) }`

  with the ledger documented as: *"Continuations replay this ledger so previously completed bridge
  [calls return their recorded results]"* and determinism state keeping *"`Date.now()` and
  `Math.random()` deterministic across approval continuations"* (types.d.ts ~:37, 157-160, 200-250).
  **Resume = deterministic re-execution of the source with memoized results — precisely our
  proposed durable-codemode mechanism, shipped.**
- **Continuation security**: HMAC signing key + max age. Eve stores a per-session 32-byte key in
  harness state and raises the max age to **365 days** because "a parked workflow can legitimately
  wait far beyond code mode's one-hour default"
  (`harness/workflow-continuation-security.ts:25-50`).

### 3c. How eve makes it durable

The pending interrupt (continuation + the turn's response messages) is persisted in **session
state** (`harness/workflow-interrupt-state.ts:28-43`). On resume, the harness replays:

```2145:2169:.vendor/eve/packages/eve/src/harness/tool-loop.ts
    // Promise.all can park several child calls together. Resolve one ledger
    // entry per replay until every supplied child result has been consumed.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      continuationOutput = await continueWorkflowSandboxInterrupt({
        continuationSecurity,
        interrupt: currentInterrupt,
        lifecycle,
        resolution: childResults[resultIndex]?.output,
        tools: hostTools,
      });
      const loopUnwrapped = await unwrapWorkflowSandboxResult(...);
      if (loopUnwrapped.status !== "interrupted") break;
      ...
```

Each replay feeds exactly one resolved child result; a `Promise.all` fan-out parks repeatedly until
every result is consumed. If the program parks again (a *new* interrupt), the harness re-parks
(`parkOnWorkflowInterrupt`, tool-loop.ts:2193-2208). The final result **replaces the original
`Workflow` tool-call result message in the transcript** (`replaceWorkflowToolResult`,
tool-loop.ts:2182-2186) so the model sees one clean tool result no matter how many park/resume
cycles happened.

### 3d. Observability

`createWorkflowLifecycle` (harness/workflow-lifecycle.ts:21-74) projects sandbox hooks
(`onNestedToolCall` / `onNestedToolResult`) onto eve's **existing** action event stream —
`subagent.called` / `subagent.completed` with real child session IDs, indistinguishable from direct
delegation (docs:39-48, 77-81). Every hook event carries a `replayed: boolean`, and resume passes
`skipReplayed: true` (tool-loop.ts:2131) so ledger-replayed calls don't double-emit events.
**This flag is the single most important small detail in this survey for our design** — deterministic
re-execution *forces* you to distinguish first-execution effects from replayed ones at the
observability layer, not just the side-effect layer.

**Implications**:
- **Adopt (confirmation)**: durable codemode via deterministic re-execution + memoized tool results.
  Effect's `Workflow`/`Activity` gives us this with engine support instead of a hand-rolled ledger:
  each nested tool call = `Activity` keyed by call index/name; re-execution replays activities from
  persisted results automatically.
- **Adopt**: **determinism capture** — intercept `Date.now`/`Math.random` (and any other
  nondeterminism the interpreter exposes) and record/replay them as part of the durable state.
  opencode's interpreter conveniently has no `Math.random` yet (deliberately undecided,
  codemode.md:166-167) — we should keep nondeterminism out of the guest language and provide it only
  as (memoized) tools if needed.
- **Adopt**: a `replayed` flag on all codemode-emitted events/Trace rows, and skip-replayed semantics
  in UI projections.
- **Adopt**: transcript hygiene — replace the eval tool result in place on resume; the model should
  see one tool call → one result.
- **Modify**: eve signs continuations because its continuation *travels through untrusted storage*.
  In our design the durable state lives in the kernel's own Trace/workflow store, so HMAC is
  unnecessary — but the *principle* (tool results in the ledger must not be forgeable by the model)
  is worth stating in the design doc.
- **Note the scope choice**: eve restricted codemode to *subagent orchestration only*. That's a
  product decision (Workflow = coordination layer), not a technical limit — but it shows a
  legitimate configuration of the same machinery where the tool tree passed to the sandbox is a
  narrow, hand-picked slice. Our `ToolMode` should support per-tool inclusion, not all-or-nothing.

---

## 4. Cloudflare — Code Mode, Project Think, and Dynamic Workflows (web research)

The owner asked specifically what "cloudflare think framework" does. Three distinct things, often
conflated:

### 4a. `@cloudflare/codemode` (the Code Mode package)

`createCodeTool({ tools, executor })` returns **one AI-SDK tool**; TS type definitions are generated
from the tools; the LLM writes an async arrow function calling `codemode.toolName(args)`; the code
is "normalized via AST parsing (acorn)" then handed to the executor. `DynamicWorkerExecutor` spins
up an **isolated Worker via Worker Loader** (fresh V8 isolate, ms startup); inside, a `Proxy`
intercepts `codemode.*` and routes back to the host over **Workers RPC** (`ToolDispatcher extends
RpcTarget`); `globalOutbound: null` blocks all network by default; console output is captured.
Executors are explicitly pluggable ("you can build your own for Node VM, QuickJS, containers").
Documented gap: **`needsApproval` tools execute immediately — no approval pause inside codemode
yet** (cloudflare-docs `agents/api-reference/codemode.mdx`; package README). So the hard problem eve
solved (interrupt/park/resume through the sandbox) is the one Cloudflare has not.

### 4b. Project Think / `@cloudflare/think`

Think is an **opinionated agent base class** (chat lifecycle, message persistence, streaming,
extensions) atop the Agents SDK's Durable-Object primitives (blog.cloudflare.com/project-think/;
github cloudflare/agents `design/think.md`). Relevant pieces:

- **Durable fibers** (inherited from Agents SDK, not Think-specific): `runFiber()` registers the
  invocation in DO SQLite (`cf_agents_runs`) before execution, `ctx.stash()` checkpoints
  *application-chosen* state, `onFiberRecovered()` delivers the last stash after a crash/eviction —
  **checkpoint/recover, not deterministic replay**: the developer decides what to stash and how to
  resume. Notably, per `design/think.md`, Think does *not* currently wrap chat turns in fibers —
  they rely on `keepAliveWhile()`.
- **The execution ladder**: workspace (durable fs, `@cloudflare/shell`) → isolate
  (`@cloudflare/codemode` on Dynamic Workers) → npm (`@cloudflare/worker-bundler` fetches+bundles
  packages so guest code can `import { z } from "zod"`) → browser → container. Capability model:
  start from zero ambient authority, grant per-resource bindings.
- **Self-authored extensions**: the agent writes a TypeScript program declaring permissions; Think's
  `ExtensionManager` bundles it (optionally with npm deps), loads it into a Dynamic Worker, and
  **registers its tools** — persisted in DO storage across hibernation. "The agent has a
  `github_create_pr` tool that didn't exist 30 seconds ago."

### 4c. `@cloudflare/dynamic-workflows`

~300 lines of MIT-licensed glue (npm; github cloudflare/dynamic-workflows): a wrapped `Workflow`
binding tags every `create()` with tenant metadata; one dispatcher `WorkflowEntrypoint`
(`createDynamicWorkflowEntrypoint(loadRunner)`) reads the tag when the engine wakes and reloads the
right Dynamic Worker via Worker Loader, forwarding `run(event, step)` into it. Result: **a
model-authored `run(event, step)` function executes as a first-class durable Cloudflare Workflow** —
per-step persistence (`step.do`), free hibernating sleeps (`step.sleep('24 hours')`), and
`step.waitForEvent()` for human approval. Their framing: "The agent writes the plan. The platform
runs it." Flue, when deployed on Cloudflare, consumes exactly this stack
(blog.cloudflare.com/agents-platform-flue-sdk/).

**Implications**:
- **Adopt (interop, don't reinvent)**: for our Cloudflare kernel target, the durable-codemode
  executor should be *implementable on* Dynamic Workers + dynamic-workflows — i.e., our
  `CodeExecutor` Layer for Cloudflare can compile the model's program into a `run(event, step)`
  where each nested tool call is a `step.do`. That is the platform-native version of our
  Activity-memoization design, and it's exactly what Cloudflare built the library for.
- **Adopt (vocabulary)**: the "execution ladder" is a better frame than a binary
  interpreter-vs-sandbox choice — confinement tiers are Layer implementations of the same
  `CodeExecutor` seam, escalated per task.
- **Reject for kernel-core**: fibers' stash/recover model. It's checkpointing left to application
  code — strictly weaker than deterministic replay for model-authored programs (the model won't
  write good stash logic). Fine as an *interop detail* inside a Cloudflare-hosted kernel.
- **Flag**: self-authored extensions (agent writes a new tool, it persists and registers) is where
  codemode meets skills/activation. Their approach: extension = program + permission manifest,
  loaded into a sandbox, its exports become tools. This is a concrete answer to the owner's "how
  does activation work" question — *a kernel-agnostic contract (program + manifest) with
  kernel-specific loading*.

### 4d. OpenClaw (bonus finding, from the same research thread)

OpenClaw's code mode (docs/reference/code-mode.md, off by default) is the **snapshot/restore**
counterpoint: exec/wait like Codex, but on **QuickJS-WASI**, and on suspension it **serializes the
VM state** (snapshot capped at 10 MB, TTL 900 s, statuses
`waiting|completed|failed|expired|aborted`); `wait` restores the snapshot, re-registers host
callbacks by stable name, delivers nested results, drains pending jobs. Nested calls run through
the normal OpenClaw executor (policy/approvals/audit intact). MCP callable only through the `MCP.*`
namespace inside code. Fails **closed** when the runtime is unavailable.

**Implication — reject VM snapshots for durability, keep as an optimization at most**: snapshots
are explicitly "runtime state, not user artifacts", size-limited and expiring — good for
*minutes-scale* suspension, unusable for eve-style days-long parks, version-fragile (a snapshot
ties you to the exact interpreter build), and opaque to any UI or query. Deterministic re-execution
(eve) is slower to resume but durable-store-friendly, versionable, and *auditable* — the replay
ledger IS the visualization data. Our kernel report's re-execution choice is right; cite OpenClaw as
the considered-and-rejected alternative.

---

## 5. Mastra — honestly: nothing

No codemode, no code-execution tool, no sandbox, no model-authored workflow capability found.
Searches for `codemode|code-mode`, `quickjs|isolated-vm|node:vm`, `executeCode|runCode` across
`packages/` and `mastracode/` produced only false positives ("MastraCode" is their coding-agent
product; `packages/codemod` is jscodeshift migrations). The candid `explorations/*.md` docs
(durable-agent, ralph-wiggum loops, agent networks) contain nothing about code actions. The closest
thing is **passthrough of provider-executed code tools** — their e2e tests exercise
`anthropic.tools.codeExecution_20250522` and Google's `codeExecution`
(`packages/core/src/tools/provider-tools.e2e.test.ts:67,224-298`). Mastra workflows are
developer-authored TS, not model-authored.

**Implication**: none for architecture; useful as market context (a major TS agent framework ships
2026 without codemode — it is not yet table stakes at the framework tier, only at the
harness/runtime tier).

---

## 6. pi — the deliberate counter-position: bash is the universal tool

No codemode, no interpreter, nothing eval-like in core, extensions, `packages/orchestrator`, or
pi-ai. What exists instead:

- **OS-level sandboxing of bash** as an *example extension*
  (`packages/coding-agent/examples/extensions/sandbox/index.ts:1-47`): wraps the built-in `bash`
  tool with `@anthropic-ai/sandbox-runtime` (`sandbox-exec` on macOS, bubblewrap on Linux) with
  fs/network allowlists. Confinement applied to the *existing* universal tool rather than a new
  execution surface.
- `packages/orchestrator` is a **process supervisor** for multiple pi instances over RPC
  (`src/supervisor.ts` — spawn/attach/prompt child pi processes), not code execution.
- `dynamic-tools.ts` shows runtime tool *registration* (`pi.registerTool` after session start), a
  primitive that self-authored extensions would need, but nothing writes those tools from the model.

**Implication**: pi is the null hypothesis worth naming in our report: for a *coding* agent whose
tools are already "the computer" (fs+shell), codemode adds little — the shell IS code execution, and
composition happens in bash/scripts the model writes to disk. Codemode earns its keep when the tool
catalog is **API-shaped** (MCP/SaaS/cloud bindings) rather than computer-shaped. Our Alchemy AI
domain (processes orchestrating typed cloud bindings) is squarely the API-shaped case, so this
strengthens rather than weakens our motivation — but we should scope codemode to API-shaped tools
and let a bash/sandbox tool exist beside it, not through it.

---

## 7. Vercel AI SDK (`.vendor/ai`) — sandbox-as-harness-substrate; codemode lives outside

- **`Experimental_SandboxSession`** (`packages/provider-utils/src/types/sandbox.ts:69-187`): a
  minimal capability interface — `run`/`spawn` commands + read/write files, with a `description`
  string meant to be *spliced into agent instructions*. Implementations: `sandbox-vercel` (Vercel
  Sandbox microVMs) and `sandbox-just-bash`. It's threaded through `generateText`/`streamText`/
  `Agent` as `experimental_sandbox` (`prompt/prepare-tools.ts:19-46`) so *built-in provider-defined
  tools* (bash-style) execute against it. This is agent-runs-in-a-computer plumbing, not codemode.
- **Provider-executed code interpreters are first-class**: `openai/src/tool/code-interpreter.ts`,
  `anthropic/src/tool/code-execution_20250522.ts` **and `code-execution_20260120.ts`** — the SDK
  tracks Anthropic's latest code-execution versions as typed provider tools.
- **First-party codemode exists but NOT in this repo**: the `experimental-ai-sdk-code-mode` npm
  package (§3) is Vercel's, versioned separately, consumed by eve. No `codemode` references inside
  `.vendor/ai` itself.

**Implication**: keep provider-executed code interpreters representable in our Tool layer (a Tool
whose executor is "the provider", results arriving as provider content blocks — our
`disableToolCallResolution` path already points this way). And note the packaging lesson: Vercel
ships codemode as a standalone package against the `ai` interface, exactly like our proposal to keep
codemode a Layer over the kernel rather than a kernel fork.

---

## 8. flue — confirmed: no interpreter; sandbox = the agent's computer

Confirmed cheaply, as the prior study said: flue's "sandbox" is the workspace where the agent's
shell runs (Daytona SDK, Cloudflare sandbox containers —
`examples/hello-world/src/workflows/with-sandbox.ts:1-18`, `packages/runtime/src/cloudflare/cf-sandbox.ts`),
driven via `harness.session().shell(...)`. No model-authored-code interpretation in the repo.
However, per Cloudflare's blog (§4), flue-on-Cloudflare consumes `@cloudflare/codemode` +
`@cloudflare/shell` — the harness delegates codemode to the platform beneath it. **Implication**:
supports the "codemode is a kernel/platform concern, harnesses consume it" layering — same as ours.

---

## 9. effect-smol — the durable substrate is ready; nothing codemode-specific

`packages/effect/src/unstable/workflow/` provides what our durable codemode Layer needs, and nothing
we'd have to fight:

- `Workflow.suspend(instance)` (Workflow.ts:741) — suspend the executing workflow as a first-class
  op; `SuspendOnFailure` annotation (Workflow.ts:774) — park instead of fail.
- `Activity` — named, memoized effects (result persisted; not re-run after success) — the ledger
  entries of eve's design, engine-managed.
- `DurableDeferred` — the wait-for-external-event primitive (eve's parked child result; Cloudflare's
  `step.waitForEvent`).
- `withCompensation` (Workflow.ts:716) — none of the surveyed systems have compensation for
  codemode programs; if we ever want "undo the tools this program ran", the primitive is sitting
  there.

Nothing codemode-adjacent in `unstable/ai` (Tool.ts mentions provider "code execution" only as an
example of provider-defined tools, Tool.ts:324, 1319).

**Implication**: our stack uniquely has the *engine* half already. Every surveyed system had to
hand-build ledgers (Vercel), snapshots (OpenClaw), or fibers (Cloudflare); we get replay-memoization
by construction if nested tool calls are Activities and the interpreter run is the workflow body.
The one thing to verify in a spike: interpreter execution must be deterministic given identical
Activity results (opencode's interpreter has no ambient nondeterminism — no `Math.random`, no
`Date.now` in the value space with Dates ISO-stringified at boundaries — so it already is).

---

## 10. Secondary web findings (tight)

- **Anthropic "programmatic tool calling"** (platform docs): requires `code_execution_20260120`;
  developer tools opt in via `allowed_callers: ["code_execution_20260120"]`; Claude writes Python in
  a managed container; when guest code calls a tool the **container pauses**, the API returns a
  `tool_use` block, the host answers, execution resumes — tool results go to the *container*, not
  the model context. Their published numbers: +11% on agentic search benchmarks, −24% input tokens.
  This is codemode as a **provider-hosted** capability with the pause/resume handled by the API —
  the strongest evidence that codemode's interrupt-shaped tool bridging (eve's model, our model) is
  the right contract, since Anthropic reimplemented the same shape server-side.
- **Anthropic "code execution with MCP"** (engineering blog): present MCP servers as a *filesystem
  of typed code APIs* (`./servers/google-drive/getDocument.ts`) that the model explores and imports;
  98.7% context reduction on their example; recommends a `search_tools` tool with detail-level
  parameter. Converges with opencode's `$codemode.search` and Codex's `ALL_TOOLS` — progressive
  disclosure is a solved pattern with three independent implementations.
- **smolagents**: still the original — `CodeAgent` generates Python; `LocalPythonExecutor` is an
  AST-walking Python interpreter with import allowlists (same family as opencode's interpreter,
  which validates that choice at 2+ years of production use); remote executors (E2B/Docker) for
  stronger isolation. Nothing new in 2026 that changes our analysis.

---

## Cross-cutting: the owner's "who evaluates / where's the AST / can the UI see it?" questions

Answering feedback #4 with the survey's evidence, per system:

| Question | opencode | codex | eve/Vercel | cloudflare |
|---|---|---|---|---|
| Where is the AST? | Inside the interpreter (acorn parse per execution); never stored, never exposed | Inside V8 (its own parser); pragma parsed textually | Inside QuickJS | acorn used host-side only to *normalize* code before shipping to the isolate |
| Who evaluates? | Host-process tree-walker (owned code) | V8 isolate, in-process or separate OS process | QuickJS in worker threads | A separate Worker (isolate) via Worker Loader; RPC bridge back |
| What does the UI see? | Code string (tool-call args) + live `toolCalls[]` metadata stream | Code string + nested calls as *normal tool events* through the router + `notify()` injections | Code string + `subagent.called/completed` on the parent stream (with `replayed` flags) | Code string + captured console output |
| Is the program queryable after the fact? | Only as the persisted tool call + final metadata | Session items (protocol-level) | Session state: continuation ledger is effectively a persisted call trace | Workflow instances are inspectable (`status()`) for dynamic-workflows |

**No system stores an AST or renders a call-graph from one.** The de-facto answer to "can the user
SEE the workflow the model wrote?" is: *show the code* (it's already in the transcript as the tool
call's argument) *and show the nested-call event stream*. Eve comes closest to a queryable structure
— its continuation ledger is a durable record of every bridged call with results.

**Implication for our design (this resolves the owner's question):** the AST pass in the kernel
report should be repositioned. The durable, queryable artifacts are (1) the program source — already
a Trace row because the eval tool call is a Trace row — and (2) the nested tool calls — already
Trace rows / Activities. A call-graph visualization is then a **pure derivation**
(`parse(code) + join with trace rows`) that any UI or query layer can compute on demand; it needs no
kernel support, no storage, and no evaluation-time hook beyond what tool-call Trace rows already
carry (a `parentCallId` linking nested calls to the eval call, like opencode's
`${ctx.callID}/${n}` and eve's ledger indices). The kernel obligation shrinks to: *stamp nested
calls with the eval call's ID and their sequence index*. Everything else is UI.

---

## Design deltas for the kernel report

Numbered; each with adopt / reject / modify and why. (1–5 are confirmations, 6–14 are changes or
additions.)

1. **`ToolMode` seam — ADOPT, extend to three values.** Codex ships `Direct | CodeMode |
   CodeModeOnly` (openai_models.rs:305-309) as per-model metadata. Add `CodeModeOnly` to our seam
   and treat the mode as (optionally) model-capability-driven, not only stack config.
2. **Single eval tool over a hidden/deferred tool tree — ADOPT (confirmed everywhere).** Follow
   opencode's v2 formulation: tools register as *direct* or *deferred*; deferred tools become
   codemode namespaces; direct tools stay direct even in CodeMode. Per-tool opt-out (Codex's
   `is_excluded_from_code_mode`) and narrow hand-picked trees (eve's subagents-only) must both be
   expressible — inclusion is per-tool, not all-or-nothing.
3. **Vendored opencode interpreter as reference executor — ADOPT (re-confirmed).** It is the most
   confined substrate surveyed, production-shipped behind opencode's flag, and its plain-data
   boundary + failures-as-data + eager supervised tool fibers are all Effect-native already. Keep
   `CodeExecutor` as a Layer seam with the interpreter as the default; V8-isolate and
   Cloudflare-Dynamic-Worker executors are alternative Layers (the "execution ladder").
4. **Durable codemode = deterministic re-execution + memoized tool calls — ADOPT (now verified in
   production).** Vercel's ledger+determinism+replay continuation (§3b) is our design, shipped. Ours
   is strictly stronger on Effect: nested call = `Activity`, program run = workflow body, parking =
   `Workflow.suspend`/`DurableDeferred`. Cite eve; cite OpenClaw snapshots as the rejected
   alternative (version-fragile, TTL-bound, opaque).
5. **Catalog = TS signatures rendered from schemas + progressive disclosure + search — ADOPT
   (three independent implementations).** opencode's budgeted round-robin catalog + `$codemode.search`,
   Codex's `render_json_schema_to_typescript` + `ALL_TOOLS`, Anthropic's `search_tools` with detail
   levels. We render from real Effect Schemas (no JSON-Schema reconstruction loss). This is also
   where prose-splicing shines: the catalog text is a prose artifact the kernel composes.
6. **Add a yield/wait (cell) protocol — MODIFY our design (new).** Codex and OpenClaw both let
   `exec` yield partial output while the program keeps running, resumable via `wait`. Long-running
   codemode programs are certain in our domain (cloud orchestration). Map to Effect: program runs on
   a fiber; yield = race with a deadline; `wait` re-attaches. With delta 4, a "cell" that outlives
   the process is just the durable workflow still running — our two mechanisms unify what Codex
   (in-memory cells) and eve (parked continuations) built separately.
7. **`replayed` flag on codemode Trace rows/events — ADOPT (from eve, small but critical).**
   Deterministic replay re-fires observation hooks; every emitted row must carry
   `replayed: boolean` and UI projections must skip replays. Without this, resume double-renders
   the workflow in any live view.
8. **Nested calls re-enter the normal tool pipeline — ADOPT (opencode, codex, openclaw all do).**
   Permissions/approvals/plugin-hooks/Trace for a nested call are the same code path as a direct
   call, stamped with `parentCallId` + sequence index. This single rule answers most of the owner's
   observability questions and keeps codemode from becoming a policy bypass.
9. **Approvals must interrupt, not block — ADOPT eve's shape, note Cloudflare's gap.** A nested
   call needing human approval suspends the program durably (delta 4 makes this free); it must not
   hold an interpreter thread hostage (opencode/codex block in-memory; Cloudflare documents
   approval as unsupported). This is a differentiator we get almost for free from Effect workflow.
10. **Failures as data with a typed diagnostic union — ADOPT (opencode).** The eval tool returns
    `Success | Failure` with `DiagnosticKind`; host interruption stays interruption. Also adopt
    "suggestions" on diagnostics — opencode ships fix-hints to the model.
11. **Binary/attachments stay outside the sandbox — ADOPT (opencode).** Files collected host-side,
    program sees a placeholder string. Keep interpreter values plain JSON.
12. **Reposition the AST pass as a derived view — MODIFY (resolves owner feedback #4).** No kernel
    storage, no evaluation hook: visualization = pure function over (program source Trace row +
    child call Trace rows). Kernel obligation = parent/sequence stamping only (delta 8). The
    program source already sits in the transcript where every surveyed UI shows it.
13. **Eval tool defined as `AI.Tool` like any other — CONFIRM (owner feedback #4 aligns with
    survey).** In every system the codemode tool is an ordinary tool in the registry (opencode
    `Tool.define("execute", …)`, Cloudflare `createCodeTool` returns a plain AI-SDK tool, eve's
    `Workflow` is a ToolSet entry). `export class Eval extends AI.Tool<Eval, …>()("Eval") {}` with
    the kernel providing its implementation Layer is exactly the surveyed shape.
14. **Skills/activation via codemode — NOTE Cloudflare's self-authored extensions as the concrete
    precedent.** An "extension" = program + permission manifest, loaded into the executor, exports
    become tools, persists across restarts. For us: a Skill whose body is a codemode program is
    just a Process implemented by the codemode Layer — activation is *not* a kernel concept; it's a
    Layer that registers/loads term-described programs. (Also: Codex's `store`/`load` and
    Anthropic's `save_skill`/`load_skill` show the same "programs accrete reusable state/snippets"
    pressure — worth one paragraph in the kernel report, not a primitive.)
15. **Cloudflare kernel target: interop with `@cloudflare/dynamic-workflows` — ADOPT for that
    Layer.** Compile the durable codemode run to a `run(event, step)` with nested calls as
    `step.do` / `step.waitForEvent`, loaded via Worker Loader. Don't rebuild step persistence on a
    platform that ships it.

## Honesty notes

- **`experimental-ai-sdk-code-mode` internals are inferred from published `.d.ts` typings + eve's
  consumption**, not source: the package is closed-source-ish (npm artifact; eve vendors the
  compiled bundle at build time — `packages/eve/scripts/vendor-compiled/experimental-ai-sdk-code-mode.mjs`;
  it is not installed in the snapshot's node_modules). The QuickJS substrate, ledger-replay
  semantics, determinism capture, and HMAC continuation are all explicit in the typings' doc
  comments (fetched from unpkg v1.0.16), and the replay behavior is corroborated by eve's
  `skipReplayed`/`while(true)` resume loop — but I could not read the interpreter-side source.
- **opencode's v2 core integration is documented, not present**: `packages/codemode/codemode.md:86-114`
  describes `packages/core/src/tool/registry.ts` + `execute.ts` integration with deferred tools;
  the snapshot's `core/src/tool/` has no such code (no `execute.ts`, no codemode/deferred
  references). What I cited as shipped is the `dev`-branch adapter in `packages/opencode`.
- **Codex**: I did not trace the full `exec` handler event emission
  (`core/src/tools/code_mode/execute_handler.rs`) line-by-line; the claim that nested calls emit
  normal tool events is based on dispatch going through `ToolRouter`/`ToolCallRuntime`
  (delegate.rs:56-57, 283-291) — the same runtime used for direct calls. Also: whether OpenAI's
  hosted models currently *ship* `tool_mode: code_mode_only` values I cannot verify from the repo
  (the field and tests exist; live server behavior unknown).
- **Cloudflare sections are web-sourced** (blog, docs, GitHub READMEs — July 2026), not vendored
  code. `@cloudflare/think` is stated as preview; API instability warnings apply. I did not find
  Think's source in any vendored repo.
- **Searches that came up empty** (reported as absences above): `codemode|code-mode` in mastra
  (only false positives), flue, pi; `quickjs|isolated-vm|node:vm` in mastra packages;
  `interpreter` in pi; codemode in `.vendor/ai` (the package lives outside the repo);
  `specs/**codemode**` in opencode.
- **eve's QuickJS claim**: the string "QuickJS" appears in eve only in a scenario test asserting
  `"[Unprintable QuickJS value]"` appears in built server output when Workflow is enabled and that
  `quickjs-emscripten` must NOT leak into traced dependencies
  (`test/scenarios/app-runtime-dependencies.scenario.test.ts:345-358`) — the engine is bundled
  inside the code-mode package, consistent with the typings' QuickJS memory/stack limit options.
