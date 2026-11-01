import * as sca from "@distilled.cloud/stackit/sca";
import * as Layer from "effect/Layer";
import { makeApplicationHttpBinding } from "./BindingHttp.ts";
import { GetApplicationEvents } from "./GetApplicationEvents.ts";

/**
 * HTTP implementation of {@link GetApplicationEvents}.
 *
 * @layer
 * @provides Stackit.ContainerApplications.GetApplicationEvents
 */
export const GetApplicationEventsHttp = Layer.effect(
  GetApplicationEvents,
  makeApplicationHttpBinding({
    tag: "Stackit.ContainerApplications.GetApplicationEvents",
    permissions: ["sca.application.get"],
    operation: sca.getApplicationEvents,
  }),
);
