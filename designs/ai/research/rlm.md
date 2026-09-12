# Recursive Language Models (RLMs) and "Context as Environment"

Research memo for the alchemy AI kernel design. Topic: the RLM inference paradigm (Zhang, Kraska, Khattab — MIT CSAIL, Oct 2025 blog / Dec 2025 arXiv), its follow-on ecosystem, the hunt for an "RLM engine for agents in Effect," and what any of it means for perpetual-run transcripts, `spawn`, and the charter/toolkit model.

---

## 1. The paradigm

### Mechanism, precisely

An RLM is a **drop-in replacement for a completion call** — `rlm.completion(messages)` has the same type as `gpt5.completion(messages)` — that internally refuses to feed the prompt to the transformer. Given query `q` and (potentially enormous) context `C`:

1. The context is loaded **as a variable in a Python REPL environment**. The root LM (depth 0) receives only the query, general instructions, and *metadata about the context* (its type, length, a preview) — never the context itself.
2. The root LM emits **code cells**. It can peek (`context[:2000]`), grep (`re.findall`), slice, chunk, and transform the variable programmatically, observing (truncated) execution output appended to its own transcript each turn.
3. Inside the REPL it can call **`llm_query(prompt)`** (and in later implementations `llm_query_batched`) — a recursive sub-LM call over any string it has assembled, typically a slice of `C`. Sub-call results land back in REPL variables, not (necessarily) in the root's token window. Sub-calls may use a **cheaper model** (the paper's main config: GPT-5 root, GPT-5-mini sub-calls).
4. Termination: the root emits `FINAL(answer)` or `FINAL_VAR(name)` — the latter returns a REPL variable, which is how RLMs produce **outputs longer than the model's max output tokens** (stitching sub-call results in variables).
5. **Depth/breadth discipline**: the paper's experiments fix recursion depth at 1 (sub-calls are plain LM calls, not RLMs — "workers are leaves"); breadth is bounded only softly, via prompting and iteration caps. The formalism allows sub-RLMs with their own isolated environments at arbitrary depth.

Two design choices carry all the weight: (a) **the prompt is data in an environment**, not tokens in a window — the model decides at test time what to look at; (b) **the environment can call back into the model**, so semantic work (labeling, summarizing, extracting) that code can't do gets delegated over slices small enough to avoid context rot. The authors' framing: agents decompose by *task* using human-designed scaffolds; RLMs decompose by *context*, and the LM itself chooses the decomposition.

### Evidence (read skeptically)

From the arXiv paper (four tasks, GPT-5 and Qwen3-Coder-480B):

- **OOLONG (trec_coarse, 131k tokens)** — information-dense aggregation (every line matters). RLM(GPT-5) 56.5 vs base GPT-5 44.0. The blog's headline: RLM(**GPT-5-mini**) beat plain GPT-5 by >2× correct answers on the ≥128k split, at roughly GPT-5's per-query cost.
- **OOLONG-Pairs (32k tokens, quadratic complexity)** — base GPT-5 F1 **0.04**, RLM(GPT-5) **58.0**. The emergent strategy: classify lines via batched sub-calls, then do the pairing *in code*.
- **BrowseComp-Plus, 1000 docs (6–11M tokens)** — base models can't even fit the input; RLM(GPT-5) scores **91.33** at average cost **$0.99/query** — cheaper than the ~$1.50–2.75 it would cost GPT-5-mini merely to *ingest* that many tokens once. Beats a summary agent (70.47) and CodeAct+BM25 (51.0).
- **CodeQA (23k–4.2M tokens)** — 62.0 vs 24.0 base.
- **Ablation** (REPL but no sub-calls): still scales past the context window and wins on sparse tasks — sometimes beating full RLM (CodeQA/Qwen) — but loses 10–59% on information-dense tasks. So: *the environment does the scaling; recursion does the semantics*.
- **Degradation profile**: RLM performance decays far more slowly with length and task complexity than the base model (their Figure 1). At *small* context lengths the base LM actually beats the RLM — there is a crossover point (~2^14 tokens in their scaling task).
- **Cost profile**: median RLM query is comparable to or cheaper than a base call (selective reading), but variance is high — long tails where the model thrashes (Qwen3-Coder issuing thousands of sub-calls per task, or re-verifying an already-correct answer five times before returning a wrong one). The reference implementation is sequential/blocking and does **no prefix caching** — acknowledged as low-hanging fruit.
- The updated paper also post-trains **RLM-Qwen3-8B** (+28.3% avg over its base, approaching vanilla GPT-5 on three tasks) — early evidence the trajectory is RL-able, which is the lab's real bet.

Honest caveats: benchmarks are single-shot Q&A over a *given* corpus — not perpetual conversations; N is small (20–150 queries per task); the failure appendix is candid that current models are inefficient, brittle deciders (the `FINAL()` protocol misfires, weak coders can't RLM at all). Nothing here directly measures a months-long business-process transcript.

### What RLM is not

- **Not RAG**: no index built ahead of time; access is programmatic and query-adaptive (regex today, chunk-map tomorrow, whole-corpus recursion when needed). RLM beat per-query-indexed BM25 ReAct on BrowseComp-Plus. RAG presumes you know at index time what similarity structure matters; RLM defers that decision to inference.
- **Not compaction/summarization**: compaction is lossy and irreversible — it decides *in advance* what can be forgotten. RLM keeps everything and decides *at query time* what to read. The summary-agent baseline loses on every dense task.
- **Not MemGPT-style memory tiers**: MemGPT gives the LM paging verbs over a fixed memory hierarchy designed by humans; RLM gives it a Turing-complete manipulation surface over one flat store and lets the model invent the hierarchy per query.
- **Not sub-agent delegation**: a Claude-Code-style subagent gets a *task* written by the parent (task decomposition, parent-authored brief passing through the parent's own token window). An RLM sub-call gets a *context slice selected and assembled in the environment* — the slice never transits the root's window. That distinction (pass-by-value prose vs pass-by-reference data) is the load-bearing one for alchemy — see §3.

---

## 2. Primary sources

What I actually read in full:

- **Blog**: "Recursive Language Models," Alex L. Zhang, Oct 2025 — https://alexzhang13.github.io/blog/2025/rlm/ (read in full; source of the OOLONG-split headline, the peeking/grepping/partition-map trajectory taxonomy, the LoCoDiff long-output anecdote, and the "RLMs are not agents" positioning).
- **Paper**: "Recursive Language Models," Zhang, Kraska, Khattab, arXiv:2512.24601 (Dec 2025; 9pp + appendix) — https://arxiv.org/abs/2512.24601 (read in full via HTML render, including the negative-results Appendix A and trajectory Appendix B). MIT CSAIL also lists a talk on it: https://www.csail.mit.edu/event/recursive-language-models.
- **Official code**: https://github.com/alexzhang13/rlm (plug-and-play inference engine + RL training harness, plugs into prime-rl) and https://github.com/alexzhang13/rlm-minimal (gist-grade; `rlm_repl.py` + `exec`-based REPL, depth=1, explicitly notes deeper recursion = swap `Sub_RLM` for `RLM_REPL`). READMEs read; internals skimmed via docs.
- **DSPy lineage** (same lab — Khattab is DSPy's creator): **`dspy.RLM` shipped as a first-class module** — https://dspy.ai/api/modules/RLM/ and https://dspy.ai/diving-deeper/rlm/ (read). Signature-driven (`"context, query -> answer"`), Deno/Pyodide-WASM sandbox by default, pluggable `CodeInterpreter` (E2B/Modal), `max_iterations`/`max_llm_calls` budgets, `sub_lm` for cheap recursion, `llm_query_batched` on an 8-worker pool, custom `tools` injectable into the sandbox. This is prompt-as-program absorbing context-as-environment: the RLM is just another optimizable module (GEPA can tune its signature).
- **Follow-on / adjacent (2025–2026)**, surveyed via the official repo's ecosystem list + searches: Prime Intellect's "RLM: *the* paradigm of 2026" (RLMEnv in `verifiers`, RL training focus — https://www.primeintellect.ai/blog/rlm); Ax (TS DSPy port); context-labs/HALO (RLM-based agent-optimization loop); Symbolica's ARC-AGI-2 REPL-agent results; Google ADK community write-up; Daytona sandbox guide. Community TS implementations: **code-rabi/rllm** (V8 isolates instead of subprocess, Zod-typed context), **jhsu/ai-rlm** (QuickJS-WASM sandbox, Vercel AI SDK agent/tool integration), grishahq/recursive-llm (Python/LiteLLM). "Context as environment" writ large: Anthropic's "Effective context engineering for AI agents" (just-in-time context; Claude Code's `grep`/`glob` agentic search as the retrieval-free pattern — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) and Manus's "Context Engineering for AI Agents" (file system as unlimited externalized memory; **restorable compression** — drop content, keep the path/URL — https://manus.im/en/blog/Context-Engineering-for-AI-Agents-Lessons-from-Manus). Claude Code's whole retrieval story *is* a poor-man's RLM minus recursion: context lives in files, the model greps it just-in-time, subagents get clean windows.

### The "RLM engine for agents in Effect" claim

**Resolved — with caveats — to `mepuka/recursive-llm`** (https://github.com/mepuka/recursive-llm): "An implementation of the Recursive Language Model (RLM) architecture in **Effect TypeScript**, running on Bun." I read its README in full. Design: an `Rlm` Effect service (`rlm.complete({ query, context, outputSchema?, tools? })`, plus `rlm.stream` of tagged events) over a **Scheduler** command loop (GenerateStep → ExecuteCode → CodeExecuted → Finalize), `@effect/ai` for Anthropic/OpenAI/Google providers, a **Bun.spawn subprocess sandbox** with typed JSON IPC (an IPC bridge routes `llm_query()` back through the Scheduler at `depth+1`; at `maxDepth` sub-calls degrade to one-shot generations), **budget enforcement as first-class** (max iterations / LLM calls / total tokens / wall-clock — exhaustion forces a salvage-extraction step), typed tools via Effect Schema (`RlmTool.make`), optional BM25/NLP tools, run traces, prompt caching toggle. Layer-composed configuration (`rlmBunLayer` ∘ model layer ∘ `RlmConfig`). Notable gaps: **no crash recovery/durability** (in-memory sandbox state is lost on kill), ~2 GitHub stars, single-author, and its README cites the wrong arXiv id (2502.07413). It is genuinely an "RLM engine in Effect" — but it is a *completion engine* (one query in, one answer out) with tool hooks, **not an agent kernel**: no actors, no perpetual runs, no charters, no world events. I could not find any *other* Effect-TS RLM project, nothing in the `@effect/ai` orbit or an official Effect package; if the claim you heard referred to something else (a private repo, a tweet-stage project), I could not confirm it — the above is the closest real artifact, and I'd characterize anything more ambitious as currently hypothetical: it would most plausibly be exactly what mepuka built plus durable execution and a typed environment contract, i.e. an Effect runtime for recursive, budgeted sub-LM calls with Layer-provided context stores.

---

## 3. Mapping to alchemy

### 3.1 Transcript-as-environment vs compaction vs memory tiers

Our acute problem: perpetual `Process` runs (`owner/repo#7`) park at quiescence and accumulate **unbounded append-only transcripts** — `KernelMemory.loop` concatenates every response into `prompt` forever. Three candidate disciplines:

- **Compaction**: summarize old turns. Cheap, cache-friendly, *irreversible* — and the RLM paper's summary-agent baseline is the empirical warning: on any task needing dense access to history it loses badly. For a triage process, "what exactly did the author promise in March" is precisely the query compaction destroys.
- **MemGPT tiers**: paging verbs over a designed hierarchy. Better, but we'd be hard-coding the hierarchy the model should be inventing per query.
- **RLM/transcript-as-environment**: the run's history becomes a **queryable store**; the in-window transcript stays bounded (recent turns + frozen head); the model reaches into deep history with tools when it needs to.

What does the evidence *actually* support for our case? Honestly: the benchmarks are documents-and-corpora, not conversational history — the blog *motivates* with bloated Claude Code sessions but never benchmarks them (the authors say themselves no such benchmark exists). Two things transfer with confidence: (1) selective, programmatic access beats both full-window stuffing and lossy summarization whenever queries over history are sparse or unpredictable — and business-process history access is exactly that (mostly needle-shaped: "what did the reviewer object to?"); (2) the no-index property matters for us — transcripts grow continuously, so anything requiring re-indexing (vector RAG) fights the write pattern, while grep/slice over an append-only log is free. What does *not* transfer: OOLONG-style dense aggregation over the whole history is rare in our domain, so the most dramatic RLM wins overstate our expected benefit. The right frame: **Manus-style restorable eviction as the storage policy, RLM-style tools as the access path**. Evict old turns from the window only ever by replacing them with a restorable reference ("turns 12–87 archived as span `s3`; `grep_history`/`read_span` to recall"), never by summary alone.

### 3.2 `spawn` vs RLM sub-calls: same intrinsic, different context-provisioning policy

Yes — they are the same intrinsic. Both conjure an anonymous leaf worker with a fresh window; both forbid the worker from recursing (our "workers are leaves" ≡ their depth=1); both return one answer to the caller. The single difference is **how the worker's context is provisioned**:

- `spawn` today: **pass-by-value**. The spawner *writes* the brief; every byte of worker context transits the spawner's own token window (generated as tool-call arguments). Doctrine: "it sees only what you write here."
- RLM sub-call: **pass-by-reference**. The root selects a slice *in the environment*; the slice flows store → worker without ever occupying the root's window. That's the entire scaling trick — the root can dispatch a 200k-token slice it has never read.

So `spawn` should grow an optional **`context:` grant**: alongside `instructions`/`task`/`tools`/`skills`, a set of *references* to spans of a store the spawner holds (a transcript region, a fetched document, a tool result that was evicted to the store). The kernel resolves the references and renders the content into the *worker's* window (or hands the worker read-tools scoped to those spans, if the slice is itself huge).

Does this break the isolation doctrine? No — it *generalizes* it cleanly: **"the worker sees only what you write plus what you explicitly hand it by reference."** The grant is still spawner-chosen, explicit, and enumerable (auditable in the trajectory); nothing ambient leaks; the spawner still cannot grant what it doesn't hold (references are capabilities into stores the spawner's tick gave it). What it removes is only the accidental constraint that granted context must be *re-generated token-by-token* — which is a cost/fidelity bug, not a security property (models truncate and paraphrase when copying; references don't). The rule that must survive: **no implicit "here's my transcript" grant** — the default remains empty, and there is no `context: "*"`.

### 3.3 The REPL is just a toolkit

In alchemy vocabulary, the RLM's REPL decomposes into things we already have names for: `peek`/`grep`/`slice`/`count` over a context store are **Tools**; `llm_query` over a slice is **`spawn` with a context grant**; the iteration loop is the ordinary agentic loop; budgets are ceilings the kernel enforces. **An RLM is a charter + a ContextStore binding + budgets.** No new kernel concept is required — which is the strongest possible sign the paradigm fits.

One honest complication: the paper's ablation and trajectories show that *arbitrary code* does work discrete tools can't — counting, dedup, pair-enumeration, stitching outputs in variables. Discrete grep/slice tools are a conservative first step; a sandboxed `eval` tool (V8 isolate on the planned Cloudflare DO kernel, exactly code-rabi/rllm's architecture) whose scope holds the store handles and a `spawn` bridge is the full-strength version. Ship the tools first, add `eval` behind a capability when a real charter needs it.

---

## 4. Steal / adapt / reject

### STEAL: `ContextStore` as an Effect service + store-backed history tools

A run-scoped, append-only store with span identities; Layer-provided so the in-memory kernel backs it with an array and the DO kernel backs it with storage:

```ts
export interface Span {
  readonly id: string;
  readonly label: string;        // "turns 12–87", "webhook payload", "PR diff"
  readonly bytes: number;
}

export interface ContextStoreService {
  readonly append: (label: string, text: string) => Effect.Effect<Span>;
  readonly read: (id: string, range?: [number, number]) => Effect.Effect<string>;
  readonly grep: (pattern: string, opts?: { spans?: string[]; context?: number })
    => Effect.Effect<ReadonlyArray<{ span: string; line: number; text: string }>>;
  readonly list: Effect.Effect<ReadonlyArray<Span>>;
}
export class ContextStore extends Context.Service<ContextStore, ContextStoreService>()(
  "alchemy/AI/ContextStore",
) {}
```

Expose it to charters as a **Skill** (mention = presence, activation returns the how-to prose — dormant until history actually matters, exactly what skills are for):

```ts
const History = AI.Skill("history")`
Your full history is archived in spans. ${GrepHistory} finds lines,
${ReadSpan} reads a range, ${ListSpans} shows what exists. Prefer
grep-then-read; never read a span blind.`(GrepHistory, ReadSpan, ListSpans);
```

Pair it with **restorable eviction in the kernel loop** (the KernelMemory change): when the live transcript exceeds a threshold, move the oldest turns into the store and splice one restorable marker message in their place. Never summarize-and-discard.

### STEAL: hard budgets in the kernel, not in prose

The paper's Qwen trajectories (thousands of sub-calls for one query; five redundant verification passes) prove soft discipline fails. mepuka's design is right: budgets are enforced by the runtime, and exhaustion triggers a *salvage* path, not a crash. In alchemy: a per-run `Budget` (max spawns, max sub-model tokens, max store-read bytes per quiescence interval) checked in the intrinsic handlers; on breach the tool returns a model-visible `BudgetExceeded` result (our `failureMode: "return"` discipline) so the agent lands the answer with what it has.

### ADAPT: `spawn` grows `context:` grants (and a model tier)

```ts
// compileSpawn gains:
parameters: S.Struct({
  instructions: S.String,
  task: S.String,
  tools: ..., skills: ...,
  // NEW — pass-by-reference context: span ids (optionally ranged)
  // from stores this tick's stance granted. Rendered into the
  // worker's window by the kernel; never transits the spawner's.
  context: S.optionalKey(S.Array(S.Struct({
    span: S.String,
    range: S.optionalKey(S.Tuple([S.Number, S.Number])),
  }))),
}),
```

The kernel resolves grants against the run's `ContextStore`, appends the resolved text to the worker's initial user message, and records the grant in the trajectory. Add a `model: "fast" | "default"` knob (kernel-mapped, not provider-named) so map-over-chunks work runs on the cheap tier — the paper's root-GPT-5/sub-mini split is where its cost profile comes from. This *is* `AI.rlm`: a charter whose stance mentions the History skill and whose spawn has context grants is a recursive language model over its own past.

### ADAPT: cache economics — tool-space access keeps the frozen head

Superficially RLM looks cache-hostile (re-rendered environment views). It isn't, done right: within one query the root's transcript is *append-only* (code cells + truncated outputs), and the paper's no-prefix-caching is an implementation gap, not a paradigm property. The hybrid for a perpetual run:

- The **frozen head never changes** — history tools are mentioned in prose (names only), and store *state* (span list) is delivered via the existing `<situation>` channel only when it changes.
- Deep-history access happens **in tool space**: grep/read results arrive as ordinary tool-result messages, appended — cache-safe.
- The only cache break is **eviction itself** (truncating the prefix invalidates it once per eviction). Evict in large batches at quiescence — one miss amortized over the turns it frees — rather than per-turn sliding windows.

### REJECT (for now)

- **A Python/JS REPL inside business-process charters.** Sandboxing cost and blast radius aren't justified when discrete store tools + `spawn` cover the observed access patterns (peek/grep/partition-map/summarize are all tool-shaped). Revisit as an opt-in `eval` capability on the DO kernel (V8 isolates are native there).
- **Depth > 1 recursion.** The paper itself ran depth 1 everywhere and did fine; our "workers are leaves" rule stays. Recursion through *named* delegates (dispatch) already exists for genuinely hierarchical work and carries identity + charter, which anonymous recursion launders away.
- **RLM as the run model.** An RLM is a *query-time* strategy — one question, one environment, one answer. Our runs are perpetual, event-driven, world-settled. Wrapping the whole actor loop in `rlm.completion` would discard the charter/tick/situation machinery for no benefit. RLM techniques slot *inside* runs (history access, spawn provisioning), not around them.
- **Adopting `mepuka/recursive-llm` as a dependency.** Right idioms, wrong maturity (2 stars, no durability, wrong-paper citation) — and its Scheduler duplicates what our kernel loop already is. Treat it as a design reference (budget-salvage, IPC bridge shape), not a component.
- **Betting on the benchmark magnitudes.** OOLONG-style dense aggregation is not our workload; expect the *scaling* property (bounded window, unbounded history) rather than the *headline accuracy* wins.

---

## 5. Open questions

1. **Eviction policy quality.** When the kernel archives turns, what stays in-window? Manus keeps a recited plan + recent turns; we have the frozen head + situations, which is stronger — but does a parked run waking after months need a machine-written "previously on" note (a summarizing *pointer*, not a summary-instead-of), and who writes it?
2. **Grant granularity.** Are span ids + ranges enough, or do grants need queries ("everything the author said") — which makes the grant itself a grep the kernel runs at spawn time? The latter is more RLM-ish (environment-selected) but weakens auditability of what the worker saw.
3. **Durable stores and replay.** On the DO kernel, the ContextStore is trivially durable (append-only storage), but spawn-with-grants must be deterministic on replay — snapshot the resolved grant text, or re-resolve against the immutable span? (Immutable spans make re-resolution safe; that argues for append-only being a *hard* invariant.)
4. **When does the crossover bite?** The paper shows base-LM > RLM at small contexts. Our runs start small. The history skill should be dormant (unmentioned or unactivated) until the store is non-trivial — can the kernel gate its mention on store size automatically, or is that the charter's judgment?
5. **Trained-RLM tailwind.** The lab's real bet is models RL-trained to recurse (RLM-Qwen3-8B; Prime Intellect's RLMEnv). If frontier models ship natively trained on grep/slice/sub-query trajectories, our store tools become the natural interface those models expect — worth tracking, since it would flip "adapt" recommendations toward "steal more aggressively."
6. **The `eval` capability.** If a charter genuinely needs OOLONG-shaped work (counting, pairing over history), discrete tools won't cut it. Is a V8-isolate eval tool with store handles + spawn bridge an acceptable capability under our authority model (it can compose grants the prose never mentioned)?
