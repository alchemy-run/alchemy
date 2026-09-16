# Synthesis constraint: Effect-native substrate, minimal reified structure

Author feedback on the teleo-reactive report's `AI.stances`/`AI.when`/`AI.otherwise`
sketch (2026-07-22): prefer Effect primitives (`Ref`, `Match`) and `.pipe`
composability over a rigid custom DSL. This note pins the constraint the final
design must satisfy, and the analysis behind it.

## The rule

**Reify only what the kernel must inspect; everything else stays an open
Effect value composed with ordinary combinators.**

- The charter surface is and remains `Effect<Fragment>` (turn) inside
  `Effect<Turn>` (init). Any user expression that produces a `Fragment` is a
  valid charter — `Match`, ternaries, plain `Effect.gen`. No combinator is
  ever required.
- Custom combinators, where they exist, are **pipeable functions over Effect
  values** (`Effect<Fragment> → Effect<Fragment>`, guards as
  `Effect<boolean>`), never a closed AST with its own evaluation semantics.
  Precedent: `Schedule`, `Layer`, `HttpRouter` — domain algebras whose nodes
  are ordinary Effect values carrying metadata.

## What Effect already covers (do not rebuild)

| Need | Effect-native answer |
| --- | --- |
| Branch selection in a turn | `Match.value(...)` / ternaries — R channel already unions branch requirements |
| Guard composition | `Effect<boolean>` + `Effect.map/zipWith` |
| Retry/backoff/budget shaping | `Schedule`, `Effect.retry/repeat/timeout` |
| Dependency injection / capability wiring | `Layer`, `Context` |
| Typed give-up / ceilings | typed errors on the error channel (`Refused`, `BudgetExceeded`) |

## What cannot be a plain expression (the one legitimate reification)

Closures are opaque: the kernel cannot enumerate the arms of a `Match` or
ternary, so any feature that needs to see the branches NOT taken requires the
alternation as data:

- whole-program head rendering (all rules byte-stable in the system prompt;
  situations point at the active rule) — the T-R report's S6;
- active-rule tracking → livelock/oscillation detection, dwell/hysteresis;
- coverage linting (mandatory catch-all).

Minimal reification: an ordered **list** of `(guard: Effect<boolean>, prose:
Effect<Fragment>)` pairs. Guards and prose inside the list remain arbitrary
Effects; only the alternation is data. A `Match`-based turn remains valid —
it simply doesn't get the structure-dependent kernel features.

## `AI.local` vs `Ref`/`FiberRef`

- `Local` **converges on `Ref`'s API** (`get`/`set`/`update`/`modify`) but
  cannot BE `Ref`: `Ref` ops are `R = never` (one process-memory cell);
  `Local` needs per-run identity, which is exactly what the `CurrentRun`
  requirement in its R channel encodes. The R-channel difference is the
  feature: "run-scoped" is a type-level fact.
- `FiberRef` rejected: unserializable by construction (durability) and
  unreadable outside the run's fiber (steer/settle, observability, spawn).
- Per the elm-redux report: locals must become string-keyed and journaled
  (fold-cache over recorded writes) for the durable kernel — further from raw
  `Ref`, not closer; but the *surface* stays Ref-shaped.

## Annotations as pipeable metadata, not options objects

Instead of `AI.when(guard)({ establishes: ... })`, prefer:

```ts
AI.prose`...`.pipe(
  AI.establishes("gaps closed → triaging"),  // regression annotation
  AI.dwell("2 ticks"),                       // hysteresis
)
```

i.e. `Effect<Fragment> → Effect<Fragment>` combinators that attach metadata
to the produced Fragment. Kernel features read the metadata when present;
absence degrades gracefully.
