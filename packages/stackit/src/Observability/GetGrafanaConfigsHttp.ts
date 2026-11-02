import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetGrafanaConfigs } from "./GetGrafanaConfigs.ts";

/**
 * HTTP implementation of {@link GetGrafanaConfigs}.
 *
 * @layer
 * @provides Stackit.Observability.GetGrafanaConfigs
 */
export const GetGrafanaConfigsHttp = Layer.effect(
  GetGrafanaConfigs,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.GetGrafanaConfigs",
    access: INSTANCE_READ_ACCESS,
    operation: observability.getGrafanaConfigs,
  }),
);
