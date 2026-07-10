# Control refs v2: keep them in the prose — fix the renderer

Supersedes [reassess-control-refs.md](./reassess-control-refs.md) (v1) and
proposal §A where they differ. Owner direction: "`until: AI.until(S)` makes no
sense … make them part of the prose and render the until properly."

**Verdict up front: direction (2), pure.** Control refs stay interpolated in
the charter, exactly as today, and remain the type carriers they already are.
The only bug was `displayRef` returning `""`. Fix the renderer so each control
ref renders its kernel-worded prose *in place*; the kernel stops re-appending
the halt out-of-band. No config argument. No call-site changes — `org.ts`
compiles unmodified and its rendered prompt gets *better*. v1's structured
config is rejected: it created the `until: AI.until(…)` stutter, added a second
declaration surface and a kind-merge typing swamp, all to relocate refs whose
only defect was a renderer that erased them.

## 1. The exhibit: the prose is a lie (current Channel kind)

**(a) What the author wrote** (`examples/agent-chat-web/src/org.ts`) — the
scaffold ends:

```
4. Resolve the moment the Post needs nothing more. …
${AI.until(S.String)`the Post is resolved — every needed member reply is
relayed and the resolution states the outcome`}
${AI.budget({ iterations: 8 })}
```

**(b) What `renderTemplate` produces** — `displayRef` (`Render.ts:30–46`) hits
`default:` for `Halt` and `Budget` and returns `""`; `normalize` mops up the
blank lines. The charter body simply ends at "…resolve saying what is
missing." Both authored lines vanish.

**(c) What the model actually receives** — `KernelMemory.ts:1066–1073` builds
`system = renderTemplate(term.template, term.refs) +
kernelPrompts.haltContract(…)`, where the kernel *separately* renders
`halt.template` and re-appends it under its own heading:

```
…4. Resolve the moment the Post needs nothing more. …

# Halt condition
This run ends when: the Post is resolved — every needed member reply is
relayed and the resolution states the outcome
When that condition is met, call the `resolve` tool with the result value. …
```

So: the halt prose reaches the model only because the kernel strips it out of
the template and re-injects it at a position of *its* choosing; the budget
reaches the model **never** (`{ iterations: 8 }` only sets `maxIterations`,
`KernelMemory.ts:1075` — the model is not told it has 8 iterations); and
Flywheel-style `"at most ${AI.concurrency(3)} in flight"` renders as "at most
in flight" — the `3` evaporates. The charter a human reads is not the prompt
the model gets. That is the entire problem. Note what it is *not*: it is not
"refs don't belong in prose" — capability refs render fine. It's that three
`displayRef` arms were left as `""` with a "Phase 1 backlog" comment.

## 2. Direction (2), fully designed: in-prose, rendered properly

The ref is **already** both a type carrier and a render token — `ProcessOut`
derives `Out` from the `Halt` in the refs tuple, `ProcessIn` from `Trigger`s,
`ProcessErr` from `Budget`, `Services` folds nested-template tags into `Req`
(`Process.ts:74–113`, `Services.ts`), all independent of rendering. Nothing
about the type derivation changes. The design is one file:

```ts
// Render.ts — renderTemplate gains term-level context, displayRef renders data
export const renderTemplate = (template, refs) => {
  const ctx = { verified: refs.some(isCheck) };   // haltContract's flag
  let out = template[0] ?? "";
  refs.forEach((ref, i) => { out += displayRef(ref, ctx) + (template[i + 1] ?? ""); });
  return normalize(out);
};

const displayRef = (ref: unknown, ctx: { verified: boolean }): string => {
  // …string/number/Param/Tool/Agent/Process arms unchanged…
  switch (kind) {
    case "Halt": {
      const halt = ref as Halt;
      const prose = renderTemplate(halt.template, halt.refs); // nested ${Tool}s render
      return halt.mode === "never"
        ? kernelPrompts.perpetualNote({ healthProse: prose })
        : kernelPrompts.haltContract({ haltProse: prose,
            hasSchema: halt.schema !== undefined, verified: ctx.verified });
    }
    case "Budget":       return kernelPrompts.budgetNote((ref as Budget).limits); // NEW asset
    case "Concurrency":  return String((ref as Concurrency).n);                   // "3"
    case "Trigger":      return describeTrigger(ref as Trigger); // sources' names / "{param}" / cron
    case "Observe":      return String((ref as Observe).subject["~alchemy/Name"]);
    case "Check": case "Fold": return ""; // correct, not a lie — see below
  }
};
```

Answers to the design questions:

- **What does `${AI.until(S.String)\`the tests pass\`}` render to?** The full
  halt contract block (`# Halt condition\nThis run ends when: the tests
  pass\nWhen that condition is met, call \`resolve\`…`), **at the ref's
  position**. Every existing charter already puts the halt on its own line at
  the tail, so the rendered prompt is byte-equivalent to today's — except now
  the position is the author's, and the source charter and the prompt agree.
- **Does the kernel still append its `# Halt condition` heading?** **No —
  the in-place render replaces it.** `KernelMemory` drops the
  `+ kernelPrompts.haltContract(…)` (line 1067) and `+ perpetualNote(…)`
  (line 911); `haltProse` is still computed for the verifier prompt and
  boundary nag, which are per-boundary, not system-prompt. One wording of the
  protocol, single-sourced in `kernelPrompts`, emitted once, positioned by the
  author. (A kernel lint flags a block-rendering ref spliced mid-sentence —
  the heading needs its own line.)
- **The budget finally renders.** New `kernelPrompts.budgetNote(limits)`:
  `# Budget\nCeilings for this run: at most 8 iterations[, 5M tokens, 2h
  wall-clock, $N, 3 iterations without progress]. Hitting a ceiling ends the
  run as a failure — pace your remaining work accordingly.` Rendered where the
  author put `${AI.budget(…)}` — the "you have N attempts" prose the owner
  expected, byte-stable, from data.
- **Inline narration** works for the value-shaped refs: `"at most
  ${AI.concurrency(3)} in flight"` → "at most 3 in flight";
  `"${AI.on(IssueOpened)} run ${Triage}"` → "on `github.issues.opened/o/r`
  run Triage"; `"wake ${AI.every("1 week")}"` → "wake every 1 week". We do
  **not** offer a mid-sentence clause form of `until` ("work until *the tests
  pass*, then stop") — the contract needs the resolve/give-up protocol
  somewhere, and two render forms for one ref makes byte-stable rendering
  position-fragile. The halt renders one way: the block.
- **Check/Fold render `""` — and that's honest.** Their templates are
  instructions to *other* parties: the check's prose renders into the
  verifier prompt (`KernelMemory.ts:971–974`), the fold's into the fold
  agent's. The host model's need-to-know — "your resolutions are verified" —
  is already the `verified` line inside the halt contract. Rendering nothing
  in the host prompt is correct scoping, not erasure.

Type derivation, `Req` from nested templates, kind splicing
(`spliceCharter`), and machine-observed exits (proposal §B:
`AI.until(Github.IssueClosed(repo))` renders "GitHub reports the issue
closed") all compose unchanged. Once refs render, `spliceCharter` stops being
"smuggling" — the kind's constitutional halt/budget visibly render inside
every instance's charter.

## 3. Direction (1), fully designed: object-literal config (rejected)

```ts
class Fix extends AI.Process<Fix>()("Fix", {
  until: { output: S.String, description: "the tests pass" },
  budget: { iterations: 8 },
  on: [Issues],
})`…prose…` {}

type ConfigOut<C> = C["until"] extends { output: infer Sch extends S.Top }
  ? Sch["Type"] : C["until"] extends object ? void : never;
// In/Err/Services by keyed lookup as in v1 §2.B; until+never exclusivity via
// a BoundedConfig | PerpetualConfig union marking the other key `?: never`.
```

The kernel would render `haltContract({ haltProse: c.until.description, … })`
and `budgetNote(c.budget)` into the system prompt — config *must* render or
it's the same lie relocated. What the object literal loses:

- **Nested refs in judgment prose.** `AI.until\`…${Bash} reports green\``
  contributes `Bash` to `Req` and renders its real name. A `description:
  string` is dead text: no Req, and a tool rename silently strands the prose —
  exactly the prose/config drift the framework exists to kill. Restoring it
  means `description: AI.charter\`…${Bash}…\`` — a wrapper again, the same
  stutter the owner rejected. Check/fold templates nest refs routinely
  ("grade by running ${Bash} yourself"); until's do so occasionally; this is
  a real, not theoretical, loss.
- **Position.** The condition disappears from the charter body; the source no
  longer reads complete where a human reads it.
- **Surface.** Two declaration surfaces, the `ProcessKind` config-merge typing
  (`Omit<ProcessConfig, keyof KC>` constitutional-key machinery), and a
  migration touching every constructor call site — versus zero.

## 4. The decisive comparison

Steelman of the owner's instinct — and it wins: (i) the v1 indictment's
load-bearing count was §1(c), "interpolation buys control refs nothing
prose-wise" — that was an indictment of `displayRef`, not of interpolation,
and proper rendering voids it; (ii) once the ref renders, prose position *is*
meaningful — it's render position, same as `${PostReply}`; (iii) one
declaration surface, one syntax to teach ("everything about the process is in
its charter; every ref renders and types"); (iv) the `AI.until` naming
complaint was an artifact of the config shape — `until: AI.until(…)` stutters;
`${AI.until\`…\`}` reads as the word it is; (v) migration is two framework
files, zero call sites.

v1's counterarguments, weighed honestly: `Extract`-over-tuple inference and
the generic-guard variance footguns are **already implemented, tested, and
paid for** — keyed lookup would be *simpler* but replaces working code with a
new kind-merge problem. `until`+`never` and duplicate budgets stay kernel
lints rather than type errors — a real, small loss; the lints exist
(`Lint.ts`, `Process.types.test.ts`) and fire at interpretation time, which is
construction time in practice. Neither outweighs (i)–(v).

**The third option** (judgment refs in prose; pure-data knobs — budget
numbers, concurrency — in config): the seam is real but it is **not the
declaration surface**. Budget is model-facing prose ("you have 8 attempts"
changes behavior) — it must render regardless of where it's declared, so
moving it buys only lint-to-type-error dedup at the cost of the entire config
machinery for one key. Concurrency is model-facing in fan-out coordinators
(the model spawns background runs; the cap governs it). The natural seam is
**render style**: block-rendering refs (`until`, `never`, `budget`) sit on
their own line at the tail; inline-rendering refs (`on`/`each`/`every`,
`concurrency`, `observe`) splice mid-sentence; recipient-scoped refs
(`check`, `fold`) render into their recipient's prompt. No config argument.

## 5. Final spellings

All current spellings survive — the naming problem was positional, and
direction (2) dissolves it:

| Ref | Spelling | Renders in host prompt as |
| --- | --- | --- |
| exit | `${AI.until(Schema?)\`condition\`}` | full `# Halt condition` block, in place |
| perpetual | `${AI.never\`health signals\`}` | `perpetualNote` block, in place |
| trigger | `${AI.on(Source, …)}` / `${AI.each(param)}` / `${AI.every("1 week")}` | source names / `{param}` / the expression, inline |
| budget | `${AI.budget({ iterations: 8, … })}` | `# Budget` block (new `budgetNote`), in place |
| check | `AI.check(Judge)` / `AI.check(Judge)\`…\`` | `""` (prose → verifier prompt; `verified` line in halt contract) |
| fold | `AI.fold(Scribe)` / `AI.fold(Scribe)\`…\`` | `""` (prose → fold agent's prompt) |
| concurrency | `${AI.concurrency(3)}` | `3`, inline |

## 6. Migration delta from current code

- `Render.ts` — the whole change: `displayRef` gains the arms above plus a
  `{ verified }` render context computed from the refs array. (~40 LOC)
- `KernelPrompts.ts` — add `budgetNote(limits)`; `haltContract` /
  `perpetualNote` unchanged, now invoked by the renderer.
- `KernelMemory.ts` — delete the two system-prompt appends (`~911–914`,
  `~1067–1073`); `haltProse` still feeds `verifierPrompt` / `boundaryNag`.
- `Lint.ts` — add: block-rendering ref not on its own line.
- **Unchanged:** `Process.ts`, `Halt.ts`, `Budget.ts`, `Trigger.ts`,
  `Check.ts`, `Fold.ts`, `Services.ts`, and **every constructor call site** —
  `org.ts`, `fixtures/org/processes.ts`, all tests keep their shape; only
  prompt-snapshot assertions update to the now-honest strings.
- Proposal §A is superseded (no config argument, no `Config*` types, no kind
  constitutional-config typing); §A's one surviving idea is `budgetNote`,
  which lands here as a render asset. §B (exit sources) and §C–E proceed
  unchanged on top.
