import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetLogsAlertGroup } from "./GetLogsAlertGroup.ts";

/**
 * HTTP implementation of {@link GetLogsAlertGroup}.
 *
 * @layer
 * @provides Stackit.Observability.GetLogsAlertGroup
 */
export const GetLogsAlertGroupHttp = Layer.effect(
  GetLogsAlertGroup,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.GetLogsAlertGroup",
    access: INSTANCE_READ_ACCESS,
    operation: observability.getLogsAlertgroup,
  }),
);
