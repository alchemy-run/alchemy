import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  Aggregate,
  Command,
  Domain,
  Event,
  Feed,
  Policy,
  Port,
  Rejection,
  Story,
  View,
} from "@/Fold/index.ts";

// A tiny counter domain exercising every concept the story runner supports.
class Incremented extends Event.make("Incremented", {
  data: { by: Schema.Number, total: Schema.Number },
}) {}
class Capped extends Event.make("Capped") {}
class TooBig extends Rejection.make("TooBig", { data: { max: Schema.Number } }) {}
class Increment extends Command.make("Increment", {
  input: { by: Schema.Number },
  rejects: [TooBig],
  reply: { total: Schema.Number },
}) {}
class Cap extends Command.make("Cap") {}

class Counter extends Aggregate.make("Counter", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Number, capped: Schema.Boolean }),
  initial: { total: 0, capped: false },
  commands: [Increment, Cap],
  events: [Incremented, Capped],
  decide: {
    Increment: (s, cmd) =>
      cmd.by > 10
        ? new TooBig({ max: 10 })
        : [new Incremented({ by: cmd.by, total: s.total + cmd.by })],
    Cap: (s) => (s.capped ? [] : [new Capped()]),
  },
  evolve: {
    Incremented: (s, e) => ({ ...s, total: e.total }),
    Capped: (s) => ({ ...s, capped: true }),
  },
  reply: {
    Increment: (s) => ({ total: s.total }),
  },
}) {}

class Totals extends View.make("Totals", {
  from: [Counter],
  key: Counter,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  evolve: {
    Incremented: (_, e) => ({ total: e.total }),
  },
}) {}

class History extends Feed.make("History", {
  from: [Counter],
  key: Counter,
  entry: Schema.Struct({ by: Schema.Number }),
  map: { Incremented: (e) => ({ by: e.by }) },
}) {}

class Approval extends Port.make("Approval", {
  check: { args: { total: Schema.Number }, success: { ok: Schema.Boolean } },
}) {}

class CapWhenLarge extends Policy.make("CapWhenLarge", { from: Counter, on: [Incremented] }) {}
const CapWhenLargeLive = CapWhenLarge.toLayer(
  Effect.gen(function* () {
    const approval = yield* Approval;
    const counters = yield* Counter;
    return Effect.fn(function* ({ source, event }) {
      if (event.total < 15) return;
      const { ok } = yield* approval.check({ total: event.total });
      if (ok) yield* counters.send(source, new Cap());
    });
  }),
);

class Counters extends Domain.make("Counters", {
  aggregates: [Counter],
  views: [Totals],
  feeds: [History],
  policies: [CapWhenLarge],
}) {}

const story = Story.make(Counters, { layer: Layer.mergeAll(CapWhenLargeLive), ports: [Approval] });
const c1 = Counter.ref("c-1");

describe("Fold Story", () => {
  it.effect("decides, evolves, replies and projects", () =>
    story(
      Story.given(c1, new Incremented({ by: 2, total: 2 })),
      Story.when(c1, new Increment({ by: 3 })),
      Story.then(c1, new Incremented({ by: 3, total: 5 })),
      Story.replied({ total: 5 }),
      Story.view(Totals, c1, { total: 5 }),
      Story.feed(History, c1, [{ by: 2 }, { by: 3 }]),
    ),
  );

  it.effect("asserts rejections", () =>
    story(
      Story.when(c1, new Increment({ by: 11 })),
      Story.rejected(new TooBig({ max: 10 })),
      Story.then(c1),
    ),
  );

  it.effect("suspends a policy on a Port call until it is resolved", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(c1, new Increment({ by: 6 })),
      Story.expectCall(Approval.check, { total: 16 }),
      Story.then(c1, new Incremented({ by: 6, total: 16 })),
      Story.resolve(Approval.check, { ok: true }),
      Story.then(c1, new Capped()),
      Story.state(c1, (s) => expect(s.capped).toBe(true)),
    ),
  );

  it.effect("fails on an unasserted rejection", () =>
    story(Story.when(c1, new Increment({ by: 99 }))).pipe(
      Effect.flip,
      Effect.map((failure) => expect(String((failure as any).message)).toContain("TooBig")),
    ),
  );

  it.effect("fails on an unresolved Port call", () =>
    story(
      Story.given(c1, new Incremented({ by: 10, total: 10 })),
      Story.when(c1, new Increment({ by: 9 })),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(String((failure as any).message)).toContain("unresolved Port calls"),
      ),
    ),
  );
});
