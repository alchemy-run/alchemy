import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { Hold, Order, OrderPlaced } from "./Shop.model.ts";

/** Whenever an order is placed, wait a second, then hold it, within a time limit. */
export class Linger extends Domain.Policy("Linger", {
  from: Order,
  on: [OrderPlaced],
}) {}

export const LingerLive = Linger.toLayer(
  Effect.gen(function* () {
    const orders = yield* Order;
    return Effect.fn(function* ({ source }) {
      yield* Effect.sleep("1 second");
      // The hold is sent well within its limit.
      yield* Effect.race(
        Effect.ignore(orders.send(new Hold({ id: source.id }))),
        Effect.andThen(Effect.sleep("5 seconds"), Effect.void),
      );
    });
  }),
);

/** A shop whose policy waits before it acts. */
export class Patient extends Domain.Model("Patient", {
  aggregates: [Order],
  policies: [Linger],
  eventually: {
    APlacedOrderIsHeld: (shop) =>
      shop.Order.every((order) => order.state._tag !== "Placed" || order.state.held),
  },
}) {}

export class PatientApi extends Domain.Api("PatientApi", {
  model: Patient,
  commands: ["Place"],
  views: [],
  streams: [],
  queries: [],
}) {}
