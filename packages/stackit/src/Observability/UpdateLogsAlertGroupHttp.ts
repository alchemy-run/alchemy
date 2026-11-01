import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { UpdateLogsAlertGroup } from "./UpdateLogsAlertGroup.ts";

/**
 * HTTP implementation of {@link UpdateLogsAlertGroup}.
 *
 * @layer
 * @provides Stackit.Observability.UpdateLogsAlertGroup
 */
export const UpdateLogsAlertGroupHttp = Layer.effect(
  UpdateLogsAlertGroup,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.UpdateLogsAlertGroup",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.updateLogsAlertgroup,
  }),
);
