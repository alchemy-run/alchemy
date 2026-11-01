import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DeleteLogsAlertGroup } from "./DeleteLogsAlertGroup.ts";

/**
 * HTTP implementation of {@link DeleteLogsAlertGroup}.
 *
 * @layer
 * @provides Stackit.Observability.DeleteLogsAlertGroup
 */
export const DeleteLogsAlertGroupHttp = Layer.effect(
  DeleteLogsAlertGroup,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.DeleteLogsAlertGroup",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.deleteLogsAlertgroup,
  }),
);
