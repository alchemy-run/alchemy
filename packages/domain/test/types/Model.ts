/**
 * Type-level regressions for a consumer's view of `@alchemy.run/domain`,
 * compiled under `exactOptionalPropertyTypes` (see ./tsconfig.json).
 */
import * as Domain from "@alchemy.run/domain";
import { Story, type WhenStep } from "@alchemy.run/domain/Story";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(_: T) => {};

class Incremented extends Domain.Event("Incremented", { by: Schema.Int }) {}

class Increment extends Domain.Command("Increment", {
  input: { id: Schema.String, by: Schema.Int },
  events: [Incremented],
}) {}

/** An aggregate with only the required members: no `reply`. */
class Counter extends Domain.Aggregate("Counter", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  commands: [Increment],
  keyOf: (command) => command.id,
  decide: {
    Increment: (_, command) => [Incremented.make({ by: command.by })],
  },
  evolve: {
    Incremented: (state, event) => ({ total: state.total + event.by }),
  },
}) {}

// #2959: an aggregate that leaves out optional members is still an
// `Aggregate.Any`, so a model can list it and a story can address it.
const counter: Domain.Aggregate.Any = Counter;
void counter;
const ref = Counter.ref("one");
const when = Story.when(Increment.make({ id: ref.id, by: 1 }));
const carried: WhenStep<Increment> = when;
void carried;

class CounterTotal extends Domain.View("CounterTotal", {
  from: [Counter],
  key: Counter,
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  evolve: {
    Incremented: (view, event) => ({ total: view.total + event.by }),
  },
}) {}

// #2755: a model with no projections still types what its layer provides.
class Counting extends Domain.Model("Counting", {
  aggregates: [Counter],
  views: [CounterTotal],
}) {}

class CountingEmpty extends Domain.Model("CountingEmpty", {
  aggregates: [Counter],
  views: [CounterTotal],
  projections: [],
}) {}

type Provided<M extends { readonly layer: (...args: never[]) => Layer.Layer<any, any, any> }> =
  Layer.Success<ReturnType<M["layer"]>>;

assertType<Equals<unknown extends Provided<typeof Counting> ? true : false, false>>(true);
assertType<Equals<unknown extends Provided<typeof CountingEmpty> ? true : false, false>>(true);

const needsCounter = Effect.gen(function* () {
  yield* Counter;
  yield* CounterTotal;
});
const hosted = Counting.layer(Layer.empty);
// The layer's aggregates and views satisfy what the program needs, and
// nothing else: a requirement it doesn't provide stays.
type Remaining = Exclude<Effect.Services<typeof needsCounter>, Layer.Success<typeof hosted>>;
assertType<Equals<Remaining, never>>(true);

class Other extends Domain.Aggregate("Other", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  commands: [],
  decide: {},
  evolve: {},
}) {}
const needsBoth = Effect.gen(function* () {
  yield* Counter;
  yield* Other;
});
type Missing = Exclude<Effect.Services<typeof needsBoth>, Layer.Success<typeof hosted>>;
assertType<
  Equals<Missing, Exclude<Effect.Services<typeof needsBoth>, Effect.Services<typeof needsCounter>>>
>(true);
assertType<Equals<[Missing] extends [never] ? true : false, false>>(true);
