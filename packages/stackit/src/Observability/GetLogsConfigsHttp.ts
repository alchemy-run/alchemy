import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetLogsConfigs } from "./GetLogsConfigs.ts";

/**
 * HTTP implementation of {@link GetLogsConfigs}.
 *
 * @layer
 * @provides Stackit.Observability.GetLogsConfigs
 */
export const GetLogsConfigsHttp = Layer.effect(
  GetLogsConfigs,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.GetLogsConfigs",
    access: INSTANCE_READ_ACCESS,
    operation: observability.getLogsConfigs,
  }),
);
