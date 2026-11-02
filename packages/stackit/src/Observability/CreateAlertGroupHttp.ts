import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { CreateAlertGroup } from "./CreateAlertGroup.ts";

/**
 * HTTP implementation of {@link CreateAlertGroup}.
 *
 * @layer
 * @provides Stackit.Observability.CreateAlertGroup
 */
export const CreateAlertGroupHttp = Layer.effect(
  CreateAlertGroup,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.CreateAlertGroup",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.createAlertgroups,
  }),
);
