import * as router from "@distilled.cloud/stackit/telemetry_router";
import * as Layer from "effect/Layer";
import { makeRouterHttpBinding } from "./BindingHttp.ts";
import { ListDestinations } from "./ListDestinations.ts";

/**
 * HTTP implementation of {@link ListDestinations}.
 *
 * @layer
 * @provides Stackit.Telemetry.ListDestinations
 */
export const ListDestinationsHttp = Layer.effect(
  ListDestinations,
  makeRouterHttpBinding({
    tag: "Stackit.Telemetry.ListDestinations",
    permission: "telemetry-router.destination.list",
    operation: router.listDestinations,
  }),
);
