import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListLogsAlertGroups } from "./ListLogsAlertGroups.ts";

/**
 * HTTP implementation of {@link ListLogsAlertGroups}.
 *
 * @layer
 * @provides Stackit.Observability.ListLogsAlertGroups
 */
export const ListLogsAlertGroupsHttp = Layer.effect(
  ListLogsAlertGroups,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListLogsAlertGroups",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listLogsAlertgroups,
  }),
);
