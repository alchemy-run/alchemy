import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DeleteAlertGroup } from "./DeleteAlertGroup.ts";

/**
 * HTTP implementation of {@link DeleteAlertGroup}.
 *
 * @layer
 * @provides Stackit.Observability.DeleteAlertGroup
 */
export const DeleteAlertGroupHttp = Layer.effect(
  DeleteAlertGroup,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.DeleteAlertGroup",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.deleteAlertgroup,
  }),
);
