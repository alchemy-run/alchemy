/**
 * The model every Domain platform runs for the conformance suite: an
 * aggregate that rejects, a view, a policy that starts a saga, a saga that
 * writes to another aggregate, and a policy that schedules and cancels a
 * command. Between them the platform hosts every kind of object and runs
 * its workflow engine and its durable timers.
 */
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";

export class Incremented extends Domain.Event("Incremented", { by: Schema.Int }) {}
export class TooBig extends Domain.Rejection("TooBig", { max: Schema.Int }) {}

export class Increment extends Domain.Command("Increment", {
  target: Schema.String,
  input: { by: Schema.Int },
  events: [Incremented],
  rejects: [TooBig],
  reply: { total: Schema.Int },
}) {}

export class Counter extends Domain.Aggregate("Counter", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  commands: [Increment],
  decide: {
    Increment: (_, command) =>
      command.by > 10 ? new TooBig({ max: 10 }) : [new Incremented({ by: command.by })],
  },
  evolve: {
    Incremented: (state, event) => ({ total: state.total + event.by }),
  },
  reply: {
    Increment: (state) => ({ total: state.total }),
  },
}) {}

export class Mirrored extends Domain.Event("Mirrored", { by: Schema.Int }) {}

export class Mirror extends Domain.Command("Mirror", {
  target: Schema.String,
  input: { by: Schema.Int },
  events: [Mirrored],
}) {}

/** What the saga writes, so a test can see that it ran. */
export class Echo extends Domain.Aggregate("Echo", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  commands: [Mirror],
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
  },
}) {}

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
        execute: echoes.send(key, new Mirror({ by })).pipe(Effect.orDie),
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
  target: Schema.String,
  events: [HoldPlaced],
}) {}
export class ReleaseHold extends Domain.Command("ReleaseHold", {
  target: Schema.String,
  events: [HoldReleased],
}) {}
export class ExpireHold extends Domain.Command("ExpireHold", {
  target: Schema.String,
  events: [HoldExpired],
}) {}

export class Hold extends Domain.Aggregate("Hold", {
  id: Schema.String,
  state: Schema.Struct({ status: Schema.Literals(["none", "held", "released", "expired"]) }),
  initial: { status: "none" },
  commands: [PlaceHold, ReleaseHold, ExpireHold],
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
        yield* holds.schedule(source, new ExpireHold(), { after: HOLD_WINDOW, commandId: EXPIRY });
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
  aggregates: [Counter, Echo, Hold],
  views: [CounterTotal],
  policies: [StartMirror, HoldDeadline],
  sagas: [MirrorFirst],
}) {}

/** The model's Api: its counter and view, served at the front's `/api`. */
export class ConformanceApi extends Domain.Api("ConformanceApi", {
  model: Conformance,
  commands: ["Increment"],
  views: ["CounterTotal"],
}) {}

/** The model's Layer, given the platform it runs on. */
export const ConformanceLive = Conformance.layer(
  Layer.mergeAll(StartMirrorLive, MirrorFirstLive, HoldDeadlineLive),
);
