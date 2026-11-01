import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetAlertGroup } from "./GetAlertGroup.ts";

/**
 * HTTP implementation of {@link GetAlertGroup}.
 *
 * @layer
 * @provides Stackit.Observability.GetAlertGroup
 */
export const GetAlertGroupHttp = Layer.effect(
  GetAlertGroup,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.GetAlertGroup",
    access: INSTANCE_READ_ACCESS,
    operation: observability.getAlertgroup,
  }),
);
