/**
 * Every declaration whose props can be a thunk, given one, in one model:
 * it is hosted and behaves as if each were given its props directly.
 */
import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

// Events and commands are schemas: they always take their props directly.
class Opened extends Domain.Event("Opened", { subject: Schema.String }) {}
class Closed extends Domain.Event("Closed", {}) {}
class Logged extends Domain.Event("Logged", { line: Schema.String }) {}
class Open extends Domain.Command("Open", {
  input: { doorId: Schema.String, subject: Schema.String },
  events: [Opened],
}) {}
class Close extends Domain.Command("Close", {
  input: { doorId: Schema.String },
  events: [Closed],
}) {}

class Door extends Domain.Aggregate("Door", () => ({
  id: Schema.String,
  state: Schema.Struct({ open: Schema.Boolean }),
  initial: { open: false },
  commands: [Open, Close],
  keyOf: (command) => command.doorId,
  decide: {
    Open: (_, command) => [new Opened({ subject: command.subject })],
    Close: () => [new Closed()],
  },
  evolve: { Opened: () => ({ open: true }), Closed: () => ({ open: false }) },
})) {}

class Times extends Domain.View("Times", () => ({
  from: [Door],
  key: Door,
  state: Schema.Struct({ opened: Schema.Number, closed: Schema.Number }),
  initial: { opened: 0, closed: 0 },
  evolve: {
    Opened: (state) => ({ ...state, opened: state.opened + 1 }),
    Closed: (state) => ({ ...state, closed: state.closed + 1 }),
  },
})) {}

class Log extends Domain.Stream("Log", () => ({ key: Door, entries: [Logged] })) {}

class Logger extends Domain.Projection("Logger", () => ({
  from: [Door],
  key: Door,
  on: [Opened],
  writes: [Log],
})) {}
const LoggerLive = Logger.toLayer(
  Effect.gen(function* () {
    const log = yield* Log;
    return Effect.fn(function* (batch) {
      for (const input of batch) {
        yield* log.append(input, new Logged({ line: `opened: ${input.event.subject}` }));
      }
    });
  }),
);

/** An opened door closes itself. */
class AutoClose extends Domain.Policy("AutoClose", () => ({ from: Door, on: [Opened] })) {}
const AutoCloseLive = AutoClose.toLayer(
  Effect.gen(function* () {
    const doors = yield* Door;
    return Effect.fn(function* ({ source }) {
      yield* doors.send(new Close({ doorId: source.id })).pipe(Effect.orDie);
    });
  }),
);

class House extends Domain.Model("House", () => ({
  aggregates: [Door],
  views: [Times],
  streams: [Log],
  projections: [Logger],
  policies: [AutoClose],
})) {}

class HouseApi extends Domain.Api("HouseApi", () => ({
  model: House,
  commands: ["Open"],
  views: ["Times"],
  streams: ["Log"],
})) {}

const Live = Layer.effect(HouseApi.Client, HouseApi.clientInProcess).pipe(
  Layer.provideMerge(
    House.layer(Layer.mergeAll(LoggerLive, AutoCloseLive)).pipe(Layer.provide(InMemory)),
  ),
);

describe("Domain: props given as thunks", { tags: ["unit"] }, () => {
  it.live("a model whose every declaration is a thunk is hosted as if given directly", () =>
    Effect.gen(function* () {
      const api = yield* HouseApi.Client;
      yield* api.Open({ doorId: "front", subject: "a guest" });

      // The policy closed the door; the view saw both.
      const times = yield* api.Times.get("front").pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 millis"),
          until: (state) => state?.closed === 1,
          times: 200,
        }),
      );
      expect(times).toEqual({ opened: 1, closed: 1 });

      // The projection wrote the stream.
      const last = yield* api.Log.peek("front");
      expect(last?.event).toMatchObject({ _tag: "Logged", line: "opened: a guest" });

      // The model reads its members once, the first time it is used.
      expect(House.views.map((view) => view.viewName)).toEqual(["Times"]);
      expect(HouseApi.apiName).toBe("HouseApi");
    }).pipe(Effect.provide(Live)),
  );

  it("a model given a thunk reads its members when first used, not when it loads", () => {
    // `Porch` is declared below: listing it directly here would fail now.
    class Yard extends Domain.Model("Yard", () => ({ aggregates: [Porch] })) {}
    expect(Yard.modelName).toBe("Yard");
    class Porch extends Domain.Aggregate("Porch", {
      id: Schema.String,
      state: Schema.Struct({}),
      initial: {},
      evolve: {},
    }) {}
    expect(Yard.aggregates).toEqual([Porch]);
  });
});
