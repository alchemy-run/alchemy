import * as router from "@distilled.cloud/stackit/telemetry_router";
import * as Layer from "effect/Layer";
import { makeRouterHttpBinding } from "./BindingHttp.ts";
import { GetRouter } from "./GetRouter.ts";

/**
 * HTTP implementation of {@link GetRouter}.
 *
 * @layer
 * @provides Stackit.Telemetry.GetRouter
 */
export const GetRouterHttp = Layer.effect(
  GetRouter,
  makeRouterHttpBinding({
    tag: "Stackit.Telemetry.GetRouter",
    permission: "telemetry-router.instance.get",
    operation: router.getTelemetryRouter,
  }),
);
