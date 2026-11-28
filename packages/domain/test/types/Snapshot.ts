/**
 * Type-level regressions for what a view's `snapshot` and `watch` frames say:
 * the state, the cursor it is valid at, and the position of the last fact it
 * reflects (`null` before any); a stream's `peek` and `watch` carry no position.
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
class Noted extends Domain.Event("Noted", { total: Schema.Int }) {}
class CounterLog extends Domain.Stream("CounterLog", { key: Counter, entries: [Noted] }) {}

type Position = { readonly stream: string; readonly seq: number };
assertType<Equals<Domain.Read.Position, Position>>(true);

// A view's snapshot always says its position: `null` before the key applied a fact.
const empty: Domain.Read.ViewSnapshot<null> = { state: null, cursor: 0, position: null };
const applied: Domain.Read.ViewSnapshot<number> = {
  state: 1,
  cursor: 1,
  position: { stream: "Counter/a", seq: 1 },
};
// @ts-expect-error a view's snapshot cannot leave `position` out
const missing: Domain.Read.ViewSnapshot<null> = { state: null, cursor: 0 };
void empty;
void applied;
void missing;
assertType<Equals<Domain.Read.ViewSnapshot<number>["position"], Position | null>>(true);

// A view client's `snapshot` answers it.
type SnapshotRead = Effect.Success<
  ReturnType<Domain.Api.ViewClient<typeof CounterTotal>["snapshot"]>
>;
assertType<Equals<SnapshotRead, Domain.Read.ViewSnapshot<{ readonly total: number } | null>>>(true);
assertType<Equals<SnapshotRead["position"], Position | null>>(true);
assertType<Equals<SnapshotRead["state"], { readonly total: number } | null>>(true);

// So does every frame of a view's `watch`.
type WatchFrame = Stream.Success<ReturnType<Domain.Api.ViewClient<typeof CounterTotal>["watch"]>>;
assertType<Equals<WatchFrame, Domain.Read.ViewSnapshot<{ readonly total: number } | null>>>(true);
assertType<Equals<WatchFrame["position"], Position | null>>(true);

// A stream's `peek` (its latest entry) and `watch` frames (plain snapshots) carry no `position`.
type Tail = Effect.Success<ReturnType<Domain.Api.StreamClient<typeof CounterLog>["peek"]>>;
declare const tail: NonNullable<Tail>;
// @ts-expect-error a stream's peek has no position
void tail.position;
type StreamFrame = Stream.Success<ReturnType<Domain.Api.StreamClient<typeof CounterLog>["watch"]>>;
declare const streamFrame: StreamFrame;
// @ts-expect-error a stream's watch frame has no position
void streamFrame.position;
declare const plain: Domain.Read.Snapshot<number>;
// @ts-expect-error a plain snapshot has no position
void plain.position;
