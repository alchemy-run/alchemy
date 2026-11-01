import * as router from "@distilled.cloud/stackit/telemetry_router";
import * as Layer from "effect/Layer";
import { makeDestinationHttpBinding } from "./BindingHttp.ts";
import { GetDestination } from "./GetDestination.ts";

/**
 * HTTP implementation of {@link GetDestination}.
 *
 * @layer
 * @provides Stackit.Telemetry.GetDestination
 */
export const GetDestinationHttp = Layer.effect(
  GetDestination,
  makeDestinationHttpBinding({
    tag: "Stackit.Telemetry.GetDestination",
    permission: "telemetry-router.destination.get",
    operation: router.getDestination,
  }),
);
