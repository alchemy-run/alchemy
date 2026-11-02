import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListAlertGroups } from "./ListAlertGroups.ts";

/**
 * HTTP implementation of {@link ListAlertGroups}.
 *
 * @layer
 * @provides Stackit.Observability.ListAlertGroups
 */
export const ListAlertGroupsHttp = Layer.effect(
  ListAlertGroups,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListAlertGroups",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listAlertgroups,
  }),
);
