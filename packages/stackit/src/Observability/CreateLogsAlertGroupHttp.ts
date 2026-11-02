import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { CreateLogsAlertGroup } from "./CreateLogsAlertGroup.ts";

/**
 * HTTP implementation of {@link CreateLogsAlertGroup}.
 *
 * @layer
 * @provides Stackit.Observability.CreateLogsAlertGroup
 */
export const CreateLogsAlertGroupHttp = Layer.effect(
  CreateLogsAlertGroup,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.CreateLogsAlertGroup",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.createLogsAlertgroups,
  }),
);
