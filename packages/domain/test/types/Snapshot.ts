/**
 * Type-level regressions for what a view's `snapshot` read says: the state,
 * the cursor it is valid at, and the position of the last fact it reflects
 * (`null` before any); `watch` frames and stream snapshots carry no position.
 * Compiled under `exactOptionalPropertyTypes` (see ./tsconfig.json), never run.
 */
import * as Domain from "@alchemy.run/domain";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

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
assertType<Equals<Domain.Read.Position, Position>>(true);

// A view's snapshot always says its position: `null` before the key applied a fact.
const empty: Domain.Read.PositionedSnapshot<null> = { state: null, cursor: 0, position: null };
const applied: Domain.Read.PositionedSnapshot<number> = {
  state: 1,
  cursor: 1,
  position: { stream: "Counter/a", seq: 1 },
};
// @ts-expect-error a view's snapshot cannot leave `position` out
const missing: Domain.Read.PositionedSnapshot<null> = { state: null, cursor: 0 };
void empty;
void applied;
void missing;
assertType<Equals<Domain.Read.PositionedSnapshot<number>["position"], Position | null>>(true);

// A view client's `snapshot` answers it.
type ViewSnapshot = Effect.Success<
  ReturnType<Domain.Api.ViewClient<typeof CounterTotal>["snapshot"]>
>;
assertType<Equals<ViewSnapshot["position"], Position | null>>(true);
assertType<Equals<ViewSnapshot["state"], { readonly total: number } | null>>(true);

// `watch` frames and a stream's snapshot are plain snapshots: no `position`.
type WatchFrame = Stream.Success<ReturnType<Domain.Api.ViewClient<typeof CounterTotal>["watch"]>>;
declare const frame: WatchFrame;
// @ts-expect-error a watch frame has no position
void frame.position;
declare const plain: Domain.Read.Snapshot<number>;
// @ts-expect-error a plain snapshot has no position
void plain.position;
