import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListBackupSchedules } from "./ListBackupSchedules.ts";

/**
 * HTTP implementation of {@link ListBackupSchedules}.
 *
 * @layer
 * @provides Stackit.Observability.ListBackupSchedules
 */
export const ListBackupSchedulesHttp = Layer.effect(
  ListBackupSchedules,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListBackupSchedules",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listBackupSchedules,
  }),
);
