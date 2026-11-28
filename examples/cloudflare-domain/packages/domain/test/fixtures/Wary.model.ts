import * as Domain from "@alchemy.run/domain";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { Hold, Order, OrderPlaced } from "./Shop.model.ts";

/** Whenever an order is placed, hold it, unless it takes longer than a limit to: the wait grows with the total. */
export class Weigh extends Domain.Policy("Weigh", {
  from: Order,
  on: [OrderPlaced],
}) {}

export const WeighLive = Weigh.toLayer(
  Effect.gen(function* () {
    const orders = yield* Order;
    return Effect.fn(function* ({ source, event }) {
      // Twice the total is even and the limit is odd: the two waits never end at once.
      yield* Effect.race(
        Effect.andThen(
          Effect.sleep(Duration.millis(event.total * 2)),
          Effect.ignore(orders.send(new Hold({ id: source.id }))),
        ),
        Effect.sleep(Duration.millis(5001)),
      );
    });
  }),
);

/** A shop whose policy holds an order only when its total is small enough to wait for. */
export class Wary extends Domain.Model("Wary", {
  aggregates: [Order],
  policies: [Weigh],
  eventually: {
    APlacedOrderIsHeld: (shop) =>
      shop.Order.every((order) => order.state._tag !== "Placed" || order.state.held),
  },
}) {}

export class WaryApi extends Domain.Api("WaryApi", {
  model: Wary,
  commands: ["Place"],
  views: [],
  streams: [],
  queries: [],
}) {}
