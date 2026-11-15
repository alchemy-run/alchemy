import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Cents = Schema.Int.check(Schema.isGreaterThan(0));

export class Sold extends Domain.Event("Sold", { shop: Schema.String, amount: Cents }) {}

export class Refunded extends Domain.Event("Refunded", { shop: Schema.String, amount: Cents }) {}

export class NothingToRefund extends Domain.Rejection("NothingToRefund", {}) {}

export class Sell extends Domain.Command("Sell", {
  target: Schema.String,
  input: { shop: Schema.String, amount: Cents },
  events: [Sold],
}) {}

export class Refund extends Domain.Command("Refund", {
  target: Schema.String,
  input: {},
  events: [Refunded],
  rejects: [NothingToRefund],
}) {}

/** One sale, at one shop. */
export class Sale extends Domain.Aggregate("Sale", {
  id: Schema.String,
  state: Schema.Union([
    Schema.TaggedStruct("New", {}),
    Schema.TaggedStruct("Sold", { shop: Schema.String, amount: Cents }),
    Schema.TaggedStruct("Refunded", {}),
  ]),
  initial: { _tag: "New" },
  commands: [Sell, Refund],
  decide: {
    Sell: (sale, command) =>
      sale._tag === "New" ? [new Sold({ shop: command.shop, amount: command.amount })] : [],
    Refund: (sale) =>
      sale._tag === "Sold"
        ? [new Refunded({ shop: sale.shop, amount: sale.amount })]
        : new NothingToRefund(),
  },
  evolve: {
    Sold: (_, event) => ({ _tag: "Sold" as const, shop: event.shop, amount: event.amount }),
    Refunded: () => ({ _tag: "Refunded" as const }),
  },
}) {}

export class TakingsChanged extends Domain.Event("TakingsChanged", { total: Schema.Int }) {}

/**
 * What each shop took. A sale is keyed by its own id, so the view says which
 * key each event goes to: the shop the event names.
 */
export class Takings extends Domain.View("Takings", {
  from: [Sale],
  key: Schema.String,
  keyOf: {
    Sold: ({ event }) => event.shop,
    Refunded: ({ event }) => event.shop,
  },
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  evolve: {
    Sold: (takings, event) => ({ total: takings.total + event.amount }),
    Refunded: (takings, event) => ({ total: takings.total - event.amount }),
  },
  events: [TakingsChanged],
  emit: {
    Sold: (_, { after }) => (after ? new TakingsChanged({ total: after.total }) : undefined),
    Refunded: (_, { after }) => (after ? new TakingsChanged({ total: after.total }) : undefined),
  },
}) {}

/** The most any shop has taken at once: a view of a view. */
export class Best extends Domain.View("Best", {
  from: [Takings],
  key: Schema.String,
  state: Schema.Struct({ best: Schema.Int }),
  initial: { best: 0 },
  evolve: {
    TakingsChanged: (best, event) => ({ best: Math.max(best.best, event.total) }),
  },
}) {}

/** Every sale and refund, written to a table outside the model. */
export class Receipts extends Domain.Projection("Receipts", {
  from: [Sale],
  key: Sale,
  on: [Sold, Refunded],
}) {}

export const ReceiptsLive = Receipts.toLayer(Effect.succeed(() => Effect.void));

/**
 * A mall of shops. Three of its rules are true: each shop's takings are the
 * sum of its sales, the best a shop has done is at least what it has now,
 * and every sale has a receipt. One is not: takings go down on a refund.
 */
export class Mall extends Domain.Model("Mall", {
  aggregates: [Sale],
  views: [Takings, Best],
  projections: [Receipts],
  invariants: {
    TakingsAreTheSales: (mall) =>
      mall.Takings.every(
        (takings) =>
          takings.state.total ===
          mall.Sale.reduce(
            (sum, sale) =>
              sale.state._tag === "Sold" && sale.state.shop === takings.id
                ? sum + sale.state.amount
                : sum,
            0,
          ),
      ),
    BestIsAtLeastNow: (mall) =>
      mall.Takings.every((takings) =>
        mall.Best.some((best) => best.id === takings.id && best.state.best >= takings.state.total),
      ),
    EverySaleHasAReceipt: (mall) =>
      mall.Sale.every(
        (sale) =>
          sale.state._tag === "New" ||
          mall.Receipts.some((receipt) => receipt.id === sale.id && receipt.event._tag === "Sold"),
      ),
    TakingsNeverFall: (mall) =>
      mall.Takings.every((takings) =>
        mall.Best.some((best) => best.id === takings.id && best.state.best === takings.state.total),
      ),
  },
}) {}

export class MallApi extends Domain.Api("MallApi", {
  model: Mall,
  commands: ["Sell", "Refund"],
  views: [],
  streams: [],
  queries: [],
}) {}
