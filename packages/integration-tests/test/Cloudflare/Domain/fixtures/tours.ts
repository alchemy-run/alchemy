import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/** Tours belong to an org; there is no Org aggregate, the org views are keyed by its id. */
export const OrgId = Schema.String.pipe(Schema.brand("OrgId"));

export class TourBooked extends Domain.Event("TourBooked", {
  orgId: OrgId,
  unit: Schema.String,
}) {}
export class TourCancelled extends Domain.Event("TourCancelled", { orgId: OrgId }) {}

export class BookTour extends Domain.Command("BookTour", {
  target: Schema.String,
  input: { orgId: OrgId, unit: Schema.String },
  events: [TourBooked],
}) {}
export class CancelTour extends Domain.Command("CancelTour", {
  target: Schema.String,
  input: { orgId: OrgId },
  events: [TourCancelled],
}) {}

export class Tour extends Domain.Aggregate("Tour", {
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

export class ScheduleChanged extends Domain.Event("ScheduleChanged", { open: Schema.Number }) {}

/** One instance per org: its open tours, by tour id. */
export class OrgSchedule extends Domain.View("OrgSchedule", {
  from: [Tour],
  key: OrgId,
  keyOf: { Tour: ({ event }) => event.orgId },
  state: Schema.Struct({ org: Schema.String, tours: Schema.Record(Schema.String, Schema.String) }),
  initial: { org: "", tours: {} },
  evolve: {
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

/** Keyed by the same schema as OrgSchedule, so it follows it without `keyOf`. */
export class OrgBusy extends Domain.View("OrgBusy", {
  from: [OrgSchedule],
  key: OrgId,
  state: Schema.Struct({ org: Schema.String, busy: Schema.Boolean }),
  initial: { org: "", busy: false },
  evolve: {
    ScheduleChanged: (_, e, { source }) => ({ org: source, busy: e.open >= 2 }),
  },
}) {}

export class Tours extends Domain.Model("Tours", {
  aggregates: [Tour],
  views: [OrgSchedule, OrgBusy],
}) {}
