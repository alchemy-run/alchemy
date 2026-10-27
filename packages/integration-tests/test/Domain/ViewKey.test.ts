import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

// Tours belong to an org. The org-wide views are keyed by the org id itself:
// there is no Org aggregate.
const OrgId = Schema.String.pipe(Schema.brand("OrgId"));
type OrgId = typeof OrgId.Type;

class TourBooked extends Domain.Event("TourBooked", { orgId: OrgId, unit: Schema.String }) {}
class TourCancelled extends Domain.Event("TourCancelled", { orgId: OrgId }) {}

class BookTour extends Domain.Command("BookTour", {
  target: Schema.String,
  input: { orgId: OrgId, unit: Schema.String },
  events: [TourBooked],
}) {}
class CancelTour extends Domain.Command("CancelTour", {
  target: Schema.String,
  input: { orgId: OrgId },
  events: [TourCancelled],
}) {}

class Tour extends Domain.Aggregate("Tour", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [BookTour, CancelTour],
  decide: {
    BookTour: (_, { orgId, unit }) => [new TourBooked({ orgId, unit })],
    CancelTour: (_, { orgId }) => [new TourCancelled({ orgId })],
  },
  evolve: { TourBooked: (s) => s, TourCancelled: (s) => s },
}) {}

class ScheduleChanged extends Domain.Event("ScheduleChanged", { open: Schema.Number }) {}

/** One instance per org: the open tours, by tour id. */
class OrgSchedule extends Domain.View("OrgSchedule", {
  from: [Tour],
  key: OrgId,
  keyOf: { Tour: ({ event }) => event.orgId },
  state: Schema.Struct({ org: Schema.String, tours: Schema.Record(Schema.String, Schema.String) }),
  initial: { org: "", tours: {} },
  evolve: {
    // `key` is the org id itself, not a ref.
    TourBooked: (s, e, { key, source }) => ({
      org: key,
      tours: { ...s.tours, [source.id]: e.unit },
    }),
    TourCancelled: (s, _, { source }) => {
      const { [source.id]: _cancelled, ...tours } = s.tours;
      return { ...s, tours };
    },
  },
  events: [ScheduleChanged],
  emit: {
    Tour: (_, { after }) => new ScheduleChanged({ open: Object.keys(after?.tours ?? {}).length }),
  },
}) {}

/** Keyed by the same schema as its source, so it needs no `keyOf`. */
class OrgBusy extends Domain.View("OrgBusy", {
  from: [OrgSchedule],
  key: OrgId,
  state: Schema.Struct({ org: Schema.String, busy: Schema.Boolean }),
  initial: { org: "", busy: false },
  evolve: {
    ScheduleChanged: (_, e, { source }) => ({ org: source, busy: e.open >= 2 }),
  },
}) {}

class Tours extends Domain.Model("Tours", {
  aggregates: [Tour],
  views: [OrgSchedule, OrgBusy],
}) {}

const story = Story.make(Tours);

// A Schema-keyed view is addressed by its value, not by a ref.
// @ts-expect-error a ref is not an OrgId
export const byRef = Story.view(OrgSchedule, Tour.ref("t-1"), Story.none);
const acme = OrgId.make("acme");
const globex = OrgId.make("globex");

describe("Domain view keyed by a schema", () => {
  it.effect("folds every aggregate's events into the org they name", () =>
    story(
      Story.when(Tour.ref("t-1"), new BookTour({ orgId: acme, unit: "1A" })),
      Story.when(Tour.ref("t-2"), new BookTour({ orgId: acme, unit: "2B" })),
      Story.when(Tour.ref("t-3"), new BookTour({ orgId: globex, unit: "9Z" })),
      Story.when(Tour.ref("t-1"), new CancelTour({ orgId: acme })),
      Story.view(OrgSchedule, acme, { org: "acme", tours: { "t-2": "2B" } }),
      Story.view(OrgSchedule, globex, { org: "globex", tours: { "t-3": "9Z" } }),
      Story.view(OrgSchedule, OrgId.make("initech"), Story.none),
      Story.emitted(OrgSchedule, acme, [{ open: 1 }, { open: 2 }, { open: 1 }]),
    ),
  );

  it.effect("a view keyed by the same schema follows it without keyOf", () =>
    story(
      Story.when(Tour.ref("t-1"), new BookTour({ orgId: acme, unit: "1A" })),
      Story.view(OrgBusy, acme, { org: "acme", busy: false }),
      Story.when(Tour.ref("t-2"), new BookTour({ orgId: acme, unit: "2B" })),
      Story.view(OrgBusy, acme, { org: "acme", busy: true }),
      Story.view(OrgBusy, globex, Story.none),
    ),
  );

  it.live("is read, watched and listed by its key", () =>
    Effect.gen(function* () {
      const tours = yield* Tour;
      const schedules = yield* OrgSchedule;
      const watched = yield* schedules.watch(acme).pipe(
        Stream.filter(Option.isSome),
        Stream.map((state) => Object.keys(state.value.tours).length),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.sleep("10 millis");
      const first = yield* tours.send("t-1", new BookTour({ orgId: acme, unit: "1A" }));
      const second = yield* tours.send("t-2", new BookTour({ orgId: acme, unit: "2B" }));
      expect(yield* Fiber.join(watched)).toEqual([1, 2]);
      const state = yield* schedules.query(acme, {
        atLeast: { stream: second.stream, version: second.version },
      });
      expect(Option.getOrNull(state)).toEqual({ org: "acme", tours: { "t-1": "1A", "t-2": "2B" } });
      const page = yield* schedules.list(acme, { take: 1 });
      expect(page.entries.map((entry) => entry.envelope.id)).toEqual(["acme"]);
      expect(page.entries.map((entry) => entry.event.open)).toEqual([1]);
      expect(first.stream).toBe("Tour/t-1");
    }).pipe(Effect.scoped, Effect.provide(Tours.layer(Layer.empty).pipe(Layer.provide(InMemory)))),
  );

  it.live("is served through an Api by its key", () =>
    Effect.gen(function* () {
      class TourApi extends Domain.Api("TourApi", OrgSchedule) {}
      const client = yield* TourApi.testClient;
      const tours = yield* Tour;
      const receipt = yield* tours.send("t-1", new BookTour({ orgId: acme, unit: "1A" }));
      const atLeast = { stream: receipt.stream, version: receipt.version };
      expect(yield* client.OrgSchedule.get(acme, { atLeast })).toEqual({
        org: "acme",
        tours: { "t-1": "1A" },
      });
      expect(yield* client.OrgSchedule.get(globex)).toBeNull();
      const { entries } = yield* client.OrgSchedule.list(acme);
      expect(entries.map((entry) => entry.event.open)).toEqual([1]);
    }).pipe(Effect.scoped, Effect.provide(Tours.layer(Layer.empty).pipe(Layer.provide(InMemory)))),
  );
});
