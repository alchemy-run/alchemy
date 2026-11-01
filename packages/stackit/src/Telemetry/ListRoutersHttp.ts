import * as router from "@distilled.cloud/stackit/telemetry_router";
import * as Layer from "effect/Layer";
import { makeRouterScopeHttpBinding } from "./BindingHttp.ts";
import { ListRouters } from "./ListRouters.ts";

/**
 * HTTP implementation of {@link ListRouters}.
 *
 * @layer
 * @provides Stackit.Telemetry.ListRouters
 */
export const ListRoutersHttp = Layer.effect(
  ListRouters,
  makeRouterScopeHttpBinding({
    tag: "Stackit.Telemetry.ListRouters",
    permission: "telemetry-router.instance.list",
    operation: router.listTelemetryRouters,
  }),
);
