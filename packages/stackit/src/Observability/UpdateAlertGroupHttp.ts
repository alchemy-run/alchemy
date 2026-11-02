import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { UpdateAlertGroup } from "./UpdateAlertGroup.ts";

/**
 * HTTP implementation of {@link UpdateAlertGroup}.
 *
 * @layer
 * @provides Stackit.Observability.UpdateAlertGroup
 */
export const UpdateAlertGroupHttp = Layer.effect(
  UpdateAlertGroup,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.UpdateAlertGroup",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.updateAlertgroup,
  }),
);
