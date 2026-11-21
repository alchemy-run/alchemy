import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { Order, OrderPlaced } from "./Shop.model.ts";

/** Whenever an order is placed, look at it, and tell someone. */
export class Notify extends Domain.Policy("Notify", {
  from: Order,
  on: [OrderPlaced],
}) {}

export const NotifyLive = Notify.toLayer(
  Effect.gen(function* () {
    const orders = yield* Order;
    return Effect.fn(function* ({ source }) {
      // Reading an instance's state from a policy is something the explorer does not follow.
      yield* orders.get(source);
    });
  }),
);

/** A shop whose one policy the explorer cannot follow. */
export class Outlet extends Domain.Model("Outlet", {
  aggregates: [Order],
  policies: [Notify],
}) {}

export class OutletApi extends Domain.Api("OutletApi", {
  model: Outlet,
  commands: ["Place"],
  views: [],
  streams: [],
  queries: [],
}) {}
