/**
 * The model every Domain platform runs for the conformance suite: an
 * aggregate that rejects, a view, a projection fed by that view, a policy
 * that starts a saga, a saga that writes to another aggregate, a policy that
 * schedules and cancels a command, and a decision that commits across two
 * instances, plus a view that refuses every reader and a command that dies.
 * Between them the platform hosts every kind of object, runs its workflow
 * engine and its durable timers, and commits atomically across instances.
 */
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";
import { latencyAggregates, latencyViews } from "./latency-model.ts";

export class Incremented extends Domain.Event("Incremented", { by: Schema.Int }) {}
export class TooBig extends Domain.Rejection("TooBig", { max: Schema.Int }) {}

export class Increment extends Domain.Command("Increment", {
  input: { id: Schema.String, by: Schema.Int },
  events: [Incremented],
  rejects: [TooBig],
  reply: { total: Schema.Int },
}) {}

export class Taken extends Domain.Event("Taken", { by: Schema.Int }) {}
export class Received extends Domain.Event("Received", { by: Schema.Int }) {}
export class Short extends Domain.Rejection("Short", { total: Schema.Int }) {}

/** Move part of one counter's total to another: both change, or neither. */
export class Give extends Domain.Command("Give", {
  input: { from: Schema.String, to: Schema.String, by: Schema.Int },
  events: [Taken, Received],
  rejects: [Short],
  reply: { total: Schema.Int },
}) {}

/** A command whose handler dies, with internals in the defect a client must never see. */
export class Explode extends Domain.Command("Explode", {
  input: { id: Schema.String },
  events: [Incremented],
}) {}

/** What the defect {@link Explode} dies with says: a client must never receive it. */
export const SECRET = "secret: SELECT * FROM accounts";

export class Counter extends Domain.Aggregate("Counter", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  commands: [Increment, Explode],
  keyOf: (command) => command.id,
  events: [Taken, Received],
  decide: {
    Increment: (_, command) =>
      command.by > 10 ? new TooBig({ max: 10 }) : [new Incremented({ by: command.by })],
    Explode: () => Effect.die(new Error(SECRET)),
  },
  evolve: {
    Incremented: (state, event) => ({ total: state.total + event.by }),
    Taken: (state, event) => ({ total: state.total - event.by }),
    Received: (state, event) => ({ total: state.total + event.by }),
  },
  reply: {
    Increment: (state) => ({ total: state.total }),
  },
}) {}

export class Giving extends Domain.Decision(Give, {
  reads: { from: Counter, to: Counter },
  keyOf: (command) => ({ from: command.from, to: command.to }),
  decide: ({ from, to }, command) =>
    command.by > from.state.total
      ? new Short({ total: from.state.total })
      : [from.record(new Taken({ by: command.by })), to.record(new Received({ by: command.by }))],
  reply: ({ from }) => ({ total: from.total }),
}) {}

export class Mirrored extends Domain.Event("Mirrored", { by: Schema.Int }) {}

export class Mirror extends Domain.Command("Mirror", {
  input: { id: Schema.String, by: Schema.Int },
  events: [Mirrored],
}) {}

/** What the saga writes, so a test can see that it ran. */
export class Echo extends Domain.Aggregate("Echo", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  commands: [Mirror],
  keyOf: (command) => command.id,
  decide: {
    Mirror: (_, command) => [new Mirrored({ by: command.by })],
  },
  evolve: {
    Mirrored: (state, event) => ({ total: state.total + event.by }),
  },
}) {}

export class CounterTotal extends Domain.View("CounterTotal", {
  from: [Counter],
  key: Counter,
  state: Schema.Struct({ total: Schema.Int, increments: Schema.Int }),
  initial: { total: 0, increments: 0 },
  evolve: {
    Incremented: (view, event) => ({
      total: view.total + event.by,
      increments: view.increments + 1,
    }),
    Taken: (view, event) => ({ ...view, total: view.total - event.by }),
    Received: (view, event) => ({ ...view, total: view.total + event.by }),
  },
}) {}

export class Hidden extends Domain.Rejection("Hidden") {}

/** A counter's total no caller may read: `validate` refuses everyone. */
export class HiddenTotal extends Domain.View("HiddenTotal", {
  from: [Counter],
  key: Counter,
  rejects: [Hidden],
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  evolve: {
    Incremented: (view, event) => ({ total: view.total + event.by }),
  },
}) {}

const HiddenTotalLive = HiddenTotal.toLayer(
  Effect.succeed(
    Effect.fn(function* () {
      return yield* new Hidden();
    }),
  ),
);

export class TotalRecorded extends Domain.Event("TotalRecorded", { total: Schema.Int }) {}

/** Each counter's totals, as its projection recorded them. */
export class Recorded extends Domain.Stream("Recorded", {
  key: Counter,
  entries: [TotalRecorded],
}) {}

/** Records each counter's total from the view, not the aggregate. */
export class TotalWriter extends Domain.Projection("TotalWriter", {
  from: [CounterTotal],
  key: Counter,
  on: [Incremented],
  writes: [Recorded],
}) {}

/** How long the projection takes over each batch, as a write to a real store does. */
export const RECORD_DELAY = "1 second";

const TotalWriterLive = TotalWriter.toLayer(
  Effect.gen(function* () {
    const recorded = yield* Recorded;
    return Effect.fn(function* (batch) {
      yield* Effect.sleep(RECORD_DELAY);
      for (const input of batch) {
        yield* recorded.append(input, new TotalRecorded({ total: input.state?.total ?? 0 }));
      }
    });
  }),
);

/** Mirrors a counter's first increment onto its Echo; one run per counter. */
export class MirrorFirst extends Domain.Saga("MirrorFirst", {
  key: Schema.String,
  input: { by: Schema.Int },
}) {}

const MirrorFirstLive = MirrorFirst.toLayer(
  Effect.gen(function* () {
    const echoes = yield* Echo;
    return Effect.fn(function* ({ key, by }) {
      yield* Activity.make({
        name: "mirror",
        execute: echoes.send(new Mirror({ id: key, by })).pipe(Effect.orDie),
      });
    });
  }),
);

export class StartMirror extends Domain.Policy("StartMirror", {
  from: Counter,
  on: [Incremented],
}) {}

const StartMirrorLive = StartMirror.toLayer(
  Effect.gen(function* () {
    const mirrors = yield* MirrorFirst;
    return Effect.fn(function* ({ source, event }) {
      yield* mirrors.start(source, { by: event.by });
    });
  }),
);

/** How long a hold lasts before it expires, unless it is released first. */
export const HOLD_WINDOW = "4 seconds";
/** The command id a hold's expiry is scheduled under. */
export const EXPIRY = "expire";

export class HoldPlaced extends Domain.Event("HoldPlaced") {}
export class HoldReleased extends Domain.Event("HoldReleased") {}
export class HoldExpired extends Domain.Event("HoldExpired") {}

export class PlaceHold extends Domain.Command("PlaceHold", {
  input: { id: Schema.String },
  events: [HoldPlaced],
}) {}
export class ReleaseHold extends Domain.Command("ReleaseHold", {
  input: { id: Schema.String },
  events: [HoldReleased],
}) {}
export class ExpireHold extends Domain.Command("ExpireHold", {
  input: { id: Schema.String },
  events: [HoldExpired],
}) {}

export class Hold extends Domain.Aggregate("Hold", {
  id: Schema.String,
  state: Schema.Struct({ status: Schema.Literals(["none", "held", "released", "expired"]) }),
  initial: { status: "none" },
  commands: [PlaceHold, ReleaseHold, ExpireHold],
  keyOf: (command) => command.id,
  decide: {
    PlaceHold: () => [new HoldPlaced()],
    ReleaseHold: () => [new HoldReleased()],
    ExpireHold: () => [new HoldExpired()],
  },
  evolve: {
    HoldPlaced: () => ({ status: "held" as const }),
    HoldReleased: () => ({ status: "released" as const }),
    HoldExpired: () => ({ status: "expired" as const }),
  },
}) {}

/** Schedules a hold's expiry when it is placed, and cancels it when it is released. */
export class HoldDeadline extends Domain.Policy("HoldDeadline", {
  from: Hold,
  on: [HoldPlaced, HoldReleased],
}) {}

const HoldDeadlineLive = HoldDeadline.toLayer(
  Effect.gen(function* () {
    const holds = yield* Hold;
    return Effect.fn(function* ({ source, event }) {
      if (event._tag === "HoldPlaced") {
        yield* holds.schedule(new ExpireHold({ id: source.id }), {
          after: HOLD_WINDOW,
          commandId: EXPIRY,
        });
      } else {
        yield* holds
          .unschedule(source, EXPIRY)
          .pipe(
            Effect.catchTag(
              ["AlreadyExecuted", "AlreadyCancelled", "NotScheduled"],
              () => Effect.void,
            ),
          );
      }
    });
  }),
);

export class Conformance extends Domain.Model("Conformance", {
  aggregates: [Counter, Echo, Hold, ...latencyAggregates],
  decisions: [Giving],
  views: [CounterTotal, HiddenTotal, ...latencyViews],
  projections: [TotalWriter],
  streams: [Recorded],
  policies: [StartMirror, HoldDeadline],
  sagas: [MirrorFirst],
}) {}

/** The model's Api: its counter and view, served at the front's `/api`. */
export class ConformanceApi extends Domain.Api("ConformanceApi", {
  model: Conformance,
  commands: ["Increment", "Explode", "Give"],
  views: ["CounterTotal", "HiddenTotal"],
}) {}

/** What the latency benchmark sends and reads: see `latency-model.ts`. */
export class LatencyApi extends Domain.Api("LatencyApi", {
  model: Conformance,
  commands: ["Increment", "TickBare", "TickOne", "TickFour", "TickChain", "TickShared"],
  views: ["CounterTotal", "OneView", "ChainSecond", "SharedByGroup"],
}) {}

/** The model's Layer, given the platform it runs on. */
export const ConformanceLive = Conformance.layer(
  Layer.mergeAll(
    StartMirrorLive,
    MirrorFirstLive,
    HoldDeadlineLive,
    HiddenTotalLive,
    TotalWriterLive,
  ),
);
