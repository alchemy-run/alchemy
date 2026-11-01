import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DeleteAlertGroups } from "./DeleteAlertGroups.ts";

/**
 * HTTP implementation of {@link DeleteAlertGroups}.
 *
 * @layer
 * @provides Stackit.Observability.DeleteAlertGroups
 */
export const DeleteAlertGroupsHttp = Layer.effect(
  DeleteAlertGroups,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.DeleteAlertGroups",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.deleteAlertgroups,
  }),
);
