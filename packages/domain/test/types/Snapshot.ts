/**
 * Type-level regressions for what a view's `snapshot` read says: the state,
 * the cursor it is valid at, and the position of the last fact it reflects.
 * Compiled under `exactOptionalPropertyTypes` (see ./tsconfig.json), never run.
 */
import * as Domain from "@alchemy.run/domain";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(_: T) => {};

class Incremented extends Domain.Event("Incremented", { by: Schema.Int }) {}
class Increment extends Domain.Command("Increment", {
  input: { id: Schema.String, by: Schema.Int },
  events: [Incremented],
}) {}
class Counter extends Domain.Aggregate("Counter", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  commands: [Increment],
  keyOf: (command) => command.id,
  decide: { Increment: (_, command) => [Incremented.make({ by: command.by })] },
  evolve: { Incremented: (state, event) => ({ total: state.total + event.by }) },
}) {}
class CounterTotal extends Domain.View("CounterTotal", {
  from: [Counter],
  key: Counter,
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  evolve: { Incremented: (view, event) => ({ total: view.total + event.by }) },
}) {}

type Position = { readonly stream: string; readonly seq: number };

// `position` is optional: a snapshot of a key that applied nothing still has the two fields it had.
const empty: Domain.Read.Snapshot<null> = { state: null, cursor: 0 };
const applied: Domain.Read.Snapshot<number> = {
  state: 1,
  cursor: 1,
  position: { stream: "Counter/a", seq: 1 },
};
void empty;
void applied;
assertType<Equals<Domain.Read.Snapshot<number>["position"], Position | undefined>>(true);

// A view client's `snapshot` answers it, typed as the read's own snapshot.
type Snapshot = Effect.Success<ReturnType<Domain.Api.ViewClient<typeof CounterTotal>["snapshot"]>>;
assertType<Equals<Snapshot["position"], Position | undefined>>(true);
assertType<Equals<Snapshot["state"], { readonly total: number } | null>>(true);
