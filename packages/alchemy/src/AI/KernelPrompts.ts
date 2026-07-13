/**
 * The kernel's prompt assets (design §2.5/§2.9): every piece of
 * kernel-authored prose that reaches a model — halt contracts, boundary
 * nags, verifier framing, synthetic tool descriptions, model-visible
 * failure texts. These are load-bearing behavioral surface, not
 * incidental strings: the nag's wording changes whether a model persists
 * or gives up; the verifier prompt is what makes maker/checker bind.
 * Colocating them here is what makes the prose auditable in one read and
 * gives the flywheel a single file to propose PRs against.
 *
 * Three tiers of prose ownership (§2.9), and this module is only the
 * third:
 *
 * 1. **Charter prose** — the user's, per term.
 * 2. **Ring instructions** — per-wiring (`AI.check(Judge)\`grade …\``).
 * 3. **Kernel assets** (this module) — harness-invariant connective
 *    tissue, shared by every conforming kernel implementation so dev
 *    (memory) and prod (Durable Object) behavior never silently diverge.
 *
 * Every render is a pure, deterministic `input → string` — byte-stable
 * renders are what make `promptHash` fossils detectable, replay
 * idempotent, and provider prompt-caching effective. Never generated at
 * runtime; the flywheel improves these *offline* as reviewed diffs.
 *
 * Deliberately NOT here (yet — each waits for its consumer): an
 * override seam (a `Context.Reference`, when a deployment actually needs
 * different prose) and a `kernelAssetsHash` folded into `promptHash`
 * (when `promptHash` itself lands). Plain functions are enough today.
 */
export const kernelPrompts = {
  // ── control-ref render blocks (in-prose, via Render.displayRef) ──
  // These are rendered WHERE THE AUTHOR INTERPOLATED THE REF (§A):
  // `${AI.until(S)\`…\`}` and `${AI.exit(AI.when(X))\`…\`}` render
  // `haltContract`, etc. — so the model sees the exit condition in the
  // author's own placement, and the kernel no longer re-appends a
  // separate heading. (Budgets are NOT prose: they are provided as a
  // Layer — `AI.budget({...})` — and the kernel enforces them; there is
  // no budget render arm.)
  haltContract: (input: {
    readonly haltProse: string;
    readonly hasSchema: boolean;
  }): string =>
    "\n\n# Halt condition\n" +
    `This run ends when: ${input.haltProse}\n` +
    "When that condition is met, call the `resolve` tool" +
    (input.hasSchema ? " with the result value" : "") +
    ". If you conclude the goal is unachievable, call `give_up` " +
    "with your evidence. Keep working until you call one of them.",

  /** Appended by the kernel (not the renderer) only when a check exists. */
  verifiedNote: (): string =>
    "\nYour resolution will be independently verified; rejected " +
    "resolutions come back with feedback.",

  perpetualNote: (input: { readonly healthProse: string }): string =>
    "\n\nThis is a perpetual ring: you serve one work item per run, " +
    `forever. Health prose: ${input.healthProse}`,

  /** Rendered where `${AI.concurrency(n)}` sits. */
  concurrencyNote: (n: number): string => `at most ${n} in flight`,

  /** The shared clause over a set of sources — each source owns its
   * clause (the combinator contract, prose guide §2.2): a `description`
   * renders verbatim ("an issue opens in owner/repo" — a full clause,
   * no "arrives" suffix); description-less sources keep the legacy
   * "{names} arrives" fallback (one suffix when ALL lack descriptions;
   * per-source "{name} arrives" in a mixed set), joined " or ".
   * Composed by `whenNote` ("when {clause}") and the machine-observed
   * exit ("This run ends when: {clause}"). */
  sourceClause: (
    sources: ReadonlyArray<{
      readonly name: string;
      readonly description?: string;
    }>,
  ): string => {
    if (sources.every((s) => s.description === undefined)) {
      return `${sources.map((s) => s.name).join(" or ")} arrives`;
    }
    return sources
      .map((s) => s.description ?? `${s.name} arrives`)
      .join(" or ");
  },

  /** Rendered where `${AI.when(…)}` sits (declaration-only: the prose
   * names the accepted message; delivery is outside code). Reads as the
   * sentence's own conjunction: "when {clause}". */
  whenNote: (input: {
    readonly sources: ReadonlyArray<{
      readonly name: string;
      readonly description?: string;
    }>;
  }): string => `when ${kernelPrompts.sourceClause(input.sources)}`,

  // ── boundary inputs ─────────────────────────────────────────────
  boundaryNag: (): string =>
    "The run has not ended: the halt condition is not met and you have " +
    "not given up. Continue working. When done, call `resolve`; if " +
    "truly blocked, call `give_up` with evidence.",

  rejectionSteer: (reason: string): string =>
    `The verifier rejected your resolution: ${reason}. Continue working ` +
    "and call `resolve` again when genuinely done.",

  completionSteer: (input: {
    readonly runKey: string;
    readonly status: string;
    readonly summary: string;
  }): string =>
    `Background run ${input.runKey} ${input.status}: ${input.summary}`,

  // ── the verifier (maker/checker) ───────────────────────────────
  verifierPrompt: (input: {
    readonly workItem: string;
    readonly haltProse: string;
    /** The claimed value as text; `undefined` for schema-less halts. */
    readonly claim?: string;
    readonly ringInstructions?: string;
  }): string =>
    "You are the VERIFIER for a loop run — maker/checker applies: the " +
    "worker's claim of done-ness is not a signal; verify independently.\n" +
    `The run's work item: ${input.workItem}\n` +
    `Halt condition: ${input.haltProse}\n` +
    "The worker claims the run is complete" +
    (input.claim === undefined ? "." : ` with value: ${input.claim}`) +
    (input.ringInstructions !== undefined
      ? `\nRing grading instructions: ${input.ringInstructions}`
      : "") +
    '\nRespond with ONLY a JSON object: {"verdict":"goal-met"} to ' +
    'accept, or {"verdict":"off-goal","reason":"…"} to reject with ' +
    "actionable feedback.",

  // ── synthetic tool descriptions ────────────────────────────────
  resolveDescription: (input: { readonly hasSchema: boolean }): string =>
    "Call when the halt condition is met. This ends the run" +
    (input.hasSchema
      ? ". `value` is the run's result as a JSON-encoded string " +
        "matching the halt condition's shape."
      : ". `note` is a one-line summary of what was achieved."),

  giveUpDescription: (): string =>
    "Call ONLY when you have concrete evidence the goal is " +
    "unachievable. `reason` must state the blocker and the evidence.",

  delegateDescription: (input: {
    readonly name: string;
    readonly charter: string;
  }): string =>
    `Delegate a task to ${input.name}. With background=false (default) ` +
    `this blocks and returns ${input.name}'s distilled result; with ` +
    "background=true it returns a run key immediately and the result " +
    "arrives later as a steer message (poll with check_runs). " +
    `${input.name}'s charter: ${input.charter}`,

  checkRunsDescription: (): string =>
    "Check the status of background runs you spawned. Returns one " +
    "line per run: key, status (running | completed | failed), and " +
    "the distilled result when settled.",

  waitRunDescription: (): string =>
    "Block until the background run with the given key settles, then " +
    "return its distilled result. Fails if the run failed.",

  // ── synthetic tool results / acks ──────────────────────────────
  resolveAck: (): string => "resolved: the run will halt",
  giveUpAck: (): string => "acknowledged: the run will refuse",
  spawnAck: (runKey: string): string =>
    `spawned background run ${runKey}; its distilled result will ` +
    "arrive as a steer message. Poll with check_runs, or block on it " +
    "with wait_run.",

  // ── model-visible failure texts ────────────────────────────────
  abortedByInterrupt: (): string => "aborted by interrupt",
  noSuchTool: (name: string): string => `no such tool: ${name}`,
  resolveInvalidJson: (error: string): string =>
    `resolve rejected — value is not valid JSON: ${error}`,
  resolveSchemaMismatch: (error: string): string =>
    `resolve rejected — value does not match the halt schema: ${error}`,
  delegateBudgetExceeded: (input: {
    readonly limit: string;
    readonly used: number;
    readonly budget: number;
  }): string =>
    `the delegate exceeded its ${input.limit} budget ` +
    `(${input.used}/${input.budget})`,
  delegateInterrupted: (): string => "the delegate was interrupted",
};
