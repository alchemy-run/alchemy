import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { Order, OrderPlaced } from "./Shop.model.ts";

/** The latest order, under a key the view picks for each event. */
export class Latest extends Domain.View("Latest", {
  from: [Order],
  key: Order,
  keyOf: { OrderPlaced: ({ source }) => source },
}) {}

/** Whenever an order is the latest, tell someone. */
export class Notify extends Domain.Policy("Notify", {
  from: Latest,
  on: [OrderPlaced],
}) {}

export const NotifyLive = Notify.toLayer(Effect.succeed(() => Effect.void));

/** A shop whose one policy reacts to a view the explorer does not fold. */
export class Outlet extends Domain.Model("Outlet", {
  aggregates: [Order],
  views: [Latest],
  policies: [Notify],
}) {}

export class OutletApi extends Domain.Api("OutletApi", {
  model: Outlet,
  commands: ["Place"],
  views: [],
  streams: [],
  queries: [],
}) {}
