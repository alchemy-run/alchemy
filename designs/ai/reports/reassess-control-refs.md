# Reassessing control refs: prose or arguments?

Prompted by the owner's complaint about `org.ts`'s Channel kind: "the until and
budget seem to always be tacked on to the end. Do they really need to be in the
prose? … If they're in the prose, I'd expect them to be *described* in the
prose."

Verdict up front: for control refs, **the prose was never the configuration**.
The renderer elides them; the kernel re-derives their prose out-of-band or not
at all. They should move to a structured config argument, with judgment prose
preserved *inside* the config values and optional inline splicing where a
charter genuinely narrates them (shape C below).

## 1. What interpolation buys today — control refs vs capability refs

Interpolating a **capability ref** (`${PostReply}`, `${Sage}`) buys three real
things: the tag joins `Req` (`Services.ts` → `LeafServices`), the name renders
into the prose exactly where the author put it (`Render.ts` → `displayRef`),
and omission is capability denial. Prose position is semantic: "relay with
${PostReply}" is an instruction.

For **control refs** the ledger is different:

- **(a) Type derivation** — real, but awkward. `ProcessOut/In/Err` run
  `Extract` over the `Refs` tuple union (`Process.ts:74–113`). This has known
  variance footguns (`isHalt`/`isTrigger` must be generic guards because a
  fixed `Halt<any, any>` won't narrow a `never`-Out halt), and conflicts are
  un-expressible in types — `Process.types.test.ts:342–367` tests duplicate
  budgets and `until`+`never` as *kernel lints*, not type errors.
- **(b) Req derivation** — real, for the three refs that carry nested
  templates (`Halt`, `Check`, `Fold`): `RefServices` folds their nested refs'
  tags in. This is genuinely valuable and must survive any redesign — but it
  attaches to the *nested template*, not to the ref's position in the charter.
- **(c) Prose rendering** — **nothing, in place.** `Render.ts` renders every
  control ref as the empty string ("they are wiring, not prose") and
  `normalize` mops up the blank lines.

### Exhibit: what the Engineering channel's model actually sees

`KernelMemory.ts:1066–1073` builds the system prompt as
`renderTemplate(term.template, term.refs) + kernelPrompts.haltContract(…)`.
Rendered (abbreviated):

```
You are the #engineering channel of a team workspace — the room's
COORDINATOR, never a participant. …

This is the engineering channel. Sage (depth: architecture, code,
trade-offs) and Scout (speed: quick takes, breadth) are here. …

For each Post:
1. Decide which member(s) should handle it …
4. Resolve the moment the Post needs nothing more. …

# Halt condition
This run ends when: the Post is resolved — every needed member reply is
relayed and the resolution states the outcome
When that condition is met, call the `resolve` tool with the result value.
If you conclude the goal is unachievable, call `give_up` with your
evidence. Keep working until you call one of them.
```

Three observations:

1. The `${AI.until…}` and `${AI.budget…}` lines **vanish in place**. The halt
   prose re-enters only because the kernel renders `halt.template` separately
   and appends it under a kernel-authored `# Halt condition` heading. Its
   position in the charter is irrelevant to what the model sees.
2. The budget renders **nowhere**. `{ iterations: 8 }` is kernel-enforced
   (`maxIterations`, `KernelMemory.ts:1075`) but the model is never told it
   has 8 iterations — the exact "you have N attempts until we abandon" prose
   the owner expected does not exist today.
3. It's worse elsewhere: Flywheel's charter reads "at most
   `${AI.concurrency(3)}` in flight" — rendered, that's "at most **in
   flight**". The `3` evaporates. The prose the human reads is not the prose
   the model gets.

So for control refs, interpolation currently buys type derivation with clunky
inference, Req derivation that belongs to the nested templates anyway, and a
rendering story that is already "structured config appended out-of-band" —
just spelled inside a template and parked at the end by convention.

## 2. Three shapes

### A. Status quo — control refs in the template

Already described. Costs: the tail-of-template convention; `Extract`-over-tuple
inference; conflicts as lints not types; the rendering lie in §1; kinds must
smuggle constitutional halts/budgets through `spliceCharter` string surgery.
Benefit: one uniform syntax, and triggers can sit next to their routing prose.

### B. Structured config argument

```ts
export interface ProcessConfig {
  readonly until?: Halt<any[], any>;      // AI.until(S)`…` — prose stays inside the value
  readonly never?: Halt<any[], never>;    // exclusivity with `until` typed below
  readonly on?: Trigger<any, any> | readonly Trigger<any, any>[];
  readonly budget?: Budget["limits"];     // plain object; AI.budget() wrapper retired
  readonly check?: Check<any, any>;       // AI.check(Judge)`…` or a MachineCheck
  readonly fold?: Fold<any, any>;
  readonly concurrency?: number;
}

type Triggers<C extends ProcessConfig> =
  C["on"] extends readonly (infer T)[] ? T : NonNullable<C["on"]>;

export type ConfigOut<C extends ProcessConfig> =
  C["until"] extends Halt<any, infer Out> ? Out : never;
export type ConfigIn<C extends ProcessConfig> =
  [Triggers<C>] extends [never] ? unknown
  : Triggers<C> extends Trigger<infer In, any> ? In : never;
export type ConfigErr<C extends ProcessConfig> =
  | (C["budget"] extends object ? BudgetExceeded : never)
  | ([ConfigOut<C>] extends [never] ? never : Refused);
export type ConfigServices<C extends ProcessConfig> =
  | RefServices<C["until"]> | RefServices<C["never"]>
  | RefServices<Triggers<C>> | RefServices<C["check"]> | RefServices<C["fold"]>;

export const Process: {
  <Self>(): <Name extends string, const C extends ProcessConfig = {}>(
    name: Name, config?: C,
  ) => <const Refs extends any[]>(
    template: TemplateStringsArray, ...refs: Refs
  ) => Process<ConfigOut<C>, ConfigIn<C>, ConfigErr<C>,
        Services<Refs> | ConfigServices<C>, Name, Refs, Self>
     & Context.Service<Self, ProcessService<ConfigOut<C>, ConfigIn<C>, ConfigErr<C>>>;
};
```

Keyed lookup (`C["until"]`) replaces `Extract` over a tuple — simpler
inference, better errors, and the lint tests become structural facts: one
`budget` key can't be declared twice; `until`+`never` is a type error via
`ProcessConfig = BoundedConfig | PerpetualConfig` (each marking the other's
key `?: never`). `Halt`/`Check`/`Fold` terms are unchanged — `(b)` Req
derivation flows through `ConfigServices` identically. The kernel reads
`term.config.until` instead of `refs.find(isHalt)`.

The gap: Flywheel-style charters narrate *per-trigger routing* ("${AI.on(
IssueOpened)} run ${Triage}"). Under pure B the subscription list moves to
config and the prose can only mention events in loose words — reintroducing
exactly the prose/config drift the framework exists to kill.

### C. Hybrid — B's config is canonical; prose may reference it inline

Everything as in B, plus: the template may interpolate the *same* ref values
declared in config, and the renderer renders control refs **from their data**
instead of eliding them — a trigger as its event description ("when an issue
is opened on alchemy-run/alchemy-effect"), `AI.concurrency(3)` as "3",
a spliced budget as "at most 8 iterations". Typing derives **only from
config**; template occurrences are display-only (identity-deduped, so
`Services<Refs>` unioning them is idempotent). The kernel still appends its
canonical `# Halt condition` contract from config — inline splices are
narrative reinforcement, not the contract.

## 3. Prose-shaped vs config-shaped, per ref

The owner's instinct draws the right line: fuzzy judgment is prose;
deterministic ceilings are config. Mapped:

| Ref | Judgment prose? | Deterministic config? | Verdict |
| --- | --- | --- | --- |
| `until` | the condition ("every needed reply is relayed…") + schema | the *slot* (this ring is bounded) | **both** — config slot holding a prose-carrying term |
| `never` | health signals that substitute for an exit | the perpetuity declaration | **both** — same treatment |
| `on` | per-event routing lives in charter prose around it | subscription list → `In`, channel tags | **both** — config for typing, inline splice for routing (the C case) |
| `each` | item-handling prose around it | queue declaration → `In` | **both** |
| `every` | — | cron expression | **config** |
| `budget` | — | ceilings; renders "" today | **config**, purely |
| `check` | optional grading instructions | who judges | **both** — already dual-shaped (`AI.check(Judge)` vs ``AI.check(Judge)`…` ``) |
| `fold` | optional fold instructions | who folds | **both** — same dual shape |
| `concurrency` | — | `n`; the `3` vanishes from prose today | **config**, purely |

Every ref is config-shaped in its *slot*; four are also prose-shaped in their
*content*. The current design conflates the two by making the slot itself a
prose position — which the renderer then has to erase.

## 4. Precedent

Every major framework puts ceilings in config and judgment in prose, without
exception: OpenAI Agents SDK — `Runner.run(agent, input, max_turns=10)`
raising `MaxTurnsExceeded` (our `BudgetExceeded`, minus the typed channel);
`instructions` is prose. LangGraph — `recursion_limit` in the invoke config;
stop conditions are graph structure. Mastra — `maxSteps` / `stopWhen` /
`toolCallConcurrency` in the options object; `instructions` separate.
AgentKit/CrewAI — `maxIter` per network/agent. Nobody derives *types* from
stop conditions — `Out` from the halt schema and conditional `BudgetExceeded`
in `Err` is this framework's genuine novelty, and it survives the move to
config intact (inference gets simpler).

## 5. Recommendation: shape C

Adopt the structured config as the only home for control *wiring*; keep
`AI.until`/`AI.check`/`AI.fold` as prose-carrying term constructors used as
config values; teach the renderer to render control refs from data so charters
that want inline narration (Flywheel's routing, "at most 3 in flight") can
splice the config'd values. Additionally: give `kernelPrompts` a
`budgetNote(limits)` rendered from config into the system prompt — the model
should finally be told "you have at most 8 iterations" (colocated,
harness-invariant, byte-stable, like `haltContract`).

The founding claim "the prose is the configuration" is not weakened — it holds
for capability refs, where it was always true, and the halt/check/fold prose
remains prose, one artifact with its schema. What moves is only the wiring
that the renderer was already erasing.

The Channel kind under the new shape (the owner's exhibit, fixed):

```ts
export const Channel = AI.Process("Channel", {
  charter: (name: string) => AI.charter`
You are the #${name} channel … ${AI.body} … For each Post: …`,
  until: AI.until(S.String)`the Post is resolved — every needed member
reply is relayed and the resolution states the outcome`,
  budget: { iterations: 8 },
  meta: { category: "channel", icon: "hash" },
});
```

Kind form typing: `ProcessKindDefinition` gains the config keys alongside
`charter`/`meta`; instance constructors accept their own config with the
kind's already-set keys typed `?: never` (constitutional — instances add, never
override), and channels derive from the merge:

```ts
export interface ProcessKindDefinition<ScaffoldRefs extends any[], KC extends ProcessConfig, Meta> {
  readonly charter: (name: string) => Charter<ScaffoldRefs>;
  readonly meta?: Meta;
  // & KC — until/budget/on/check/fold/concurrency inline
}
export interface ProcessKind<KindName extends string, ScaffoldRefs extends any[], KC extends ProcessConfig, Meta> {
  <Self>(): <Name extends string, const IC extends Omit<ProcessConfig, keyof KC> = {}>(
    name: Name, config?: IC,
  ) => <const Refs extends any[]>(template: TemplateStringsArray, ...refs: Refs) =>
    Process<ConfigOut<KC & IC>, ConfigIn<KC & IC>, ConfigErr<KC & IC>,
      Services<[...ScaffoldRefs, ...Refs]> | ConfigServices<KC & IC>,
      Name, [...ScaffoldRefs, ...Refs], Self>;
}
```

A side benefit: kinds no longer smuggle constitutional halts/budgets through
`spliceCharter` string surgery — the scaffold splices *prose only*; config
merges as a typed object.

### Migration

Mechanical, ~10 test files + 2 fixtures + the example: cut the control-ref
lines from the template tail into the config argument, keeping the
tagged-template values verbatim. Framework side: `Process.ts` (constructor,
kind, `Config*` types; delete `ProcessOut/In/Err`-over-Refs), `Services.ts`
(+`ConfigServices`), `Render.ts` (render control refs from data),
`KernelMemory.ts` (read `term.config`, add `budgetNote`), `KernelPrompts.ts`.
Test side: `Process.types.test.ts` (several lint tests become type errors,
i.e. deletable), `KernelMemory/KernelLive/OrgStress/CodingAgent/Kind` tests,
`fixtures/org/processes.ts`, `examples/agent-chat-web/src/org.ts`. Triggers
whose routing prose matters (Flywheel) keep an inline splice of the config'd
trigger; all others move wholesale. Pre-1.0, no shim warranted:
`refs.find(isHalt)` and friends are kernel-internal, so the blast radius is
exactly the constructor call sites.
