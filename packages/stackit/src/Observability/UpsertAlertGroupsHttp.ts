import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { UpsertAlertGroups } from "./UpsertAlertGroups.ts";

/**
 * HTTP implementation of {@link UpsertAlertGroups}.
 *
 * @layer
 * @provides Stackit.Observability.UpsertAlertGroups
 */
export const UpsertAlertGroupsHttp = Layer.effect(
  UpsertAlertGroups,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.UpsertAlertGroups",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.partialUpdateAlertgroups,
  }),
);
