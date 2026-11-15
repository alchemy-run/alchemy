import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Cents = Schema.Int.check(Schema.isGreaterThan(0));

/** An order of this much or more is reviewed, in cents. */
export const BIG = 100;

export class OrderPlaced extends Domain.Event("OrderPlaced", { total: Cents }) {}

export class OrderHeld extends Domain.Event("OrderHeld", {}) {}

export class OrderParked extends Domain.Event("OrderParked", {}) {}

export class AlreadyPlaced extends Domain.Rejection("AlreadyPlaced", {}) {}

export class NotPlaced extends Domain.Rejection("NotPlaced", {}) {}

export class Place extends Domain.Command("Place", {
  target: Schema.String,
  input: { total: Cents },
  events: [OrderPlaced],
  rejects: [AlreadyPlaced],
}) {}

export class Hold extends Domain.Command("Hold", {
  target: Schema.String,
  input: {},
  events: [OrderHeld],
  rejects: [NotPlaced],
}) {}

/** Set an order aside, because nobody could score it. */
export class Park extends Domain.Command("Park", {
  target: Schema.String,
  input: {},
  events: [OrderParked],
  rejects: [NotPlaced],
}) {}

export class Order extends Domain.Aggregate("Order", {
  id: Schema.String,
  state: Schema.Union([
    Schema.TaggedStruct("New", {}),
    Schema.TaggedStruct("Placed", { total: Cents, held: Schema.Boolean }),
  ]),
  initial: { _tag: "New" },
  commands: [Place, Hold, Park],
  decide: {
    Place: (order, command) =>
      order._tag === "New" ? [new OrderPlaced({ total: command.total })] : new AlreadyPlaced(),
    Hold: (order) => (order._tag === "Placed" ? [new OrderHeld({})] : new NotPlaced()),
    Park: (order) => (order._tag === "Placed" ? [new OrderParked({})] : new NotPlaced()),
  },
  evolve: {
    OrderPlaced: (_, event) => ({ _tag: "Placed" as const, total: event.total, held: false }),
    OrderHeld: (order) => (order._tag === "Placed" ? { ...order, held: true } : order),
    OrderParked: (order) => order,
  },
}) {}

/** An order's total reached {@link BIG}. */
export class BigOrder extends Domain.Event("BigOrder", { total: Cents }) {}

/** What an order came to. It says so when the total is big. */
export class Spend extends Domain.View("Spend", {
  from: [Order],
  key: Order,
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  evolve: {
    OrderPlaced: (spend, event) => ({ total: spend.total + event.total }),
  },
  events: [BigOrder],
  emit: {
    OrderPlaced: (_, { after }) =>
      after && after.total >= BIG ? new BigOrder({ total: after.total }) : undefined,
  },
}) {}

export const RiskUnavailable = Schema.TaggedStruct("RiskUnavailable", {});

/** Scores an order. It may be down. */
export class Risk extends Domain.ExternalSystem("Risk", {
  score: {
    args: { orderId: Schema.String, total: Cents },
    success: { risk: Schema.Number },
    error: RiskUnavailable,
  },
}) {}

/** Whenever an order is big, score it: hold it when it is risky, park it when the scorer is down. */
export class Review extends Domain.Policy("Review", {
  from: Spend,
  on: [BigOrder],
}) {}

export const ReviewLive = Review.toLayer(
  Effect.gen(function* () {
    const risk = yield* Risk;
    const orders = yield* Order;
    return Effect.fn(function* ({ source, event }) {
      const scored = yield* risk
        .score({ orderId: source.id, total: event.total })
        .pipe(Effect.catchTag("RiskUnavailable", () => Effect.succeed(undefined)));
      const next =
        scored === undefined ? new Park({}) : scored.risk > 0.5 ? new Hold({}) : undefined;
      if (next)
        yield* orders.send(source, next).pipe(Effect.catchTag("NotPlaced", () => Effect.void));
    });
  }),
);

/**
 * A shop that reviews its big orders. Two of its rules are true and two are
 * not: a big order can be placed, and a risky one is held.
 */
export class Shop extends Domain.Model("Shop", {
  aggregates: [Order],
  views: [Spend],
  policies: [Review],
  invariants: {
    OnlyBigOrdersAreHeld: (shop) =>
      shop.Order.every(
        (order) => order.state._tag !== "Placed" || !order.state.held || order.state.total >= BIG,
      ),
    SpendIsTheTotal: (shop) =>
      shop.Spend.every((spend) =>
        shop.Order.some(
          (order) =>
            order.id === spend.id &&
            order.state._tag === "Placed" &&
            order.state.total === spend.state.total,
        ),
      ),
    NoOrderIsBig: (shop) => shop.Spend.every((spend) => spend.state.total < BIG),
    NoOrderIsHeld: (shop) =>
      shop.Order.every((order) => order.state._tag !== "Placed" || !order.state.held),
  },
}) {}

export class ShopApi extends Domain.Api("ShopApi", {
  model: Shop,
  commands: ["Place"],
  views: [],
  streams: [],
  queries: [],
}) {}
