import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { CreateBackupSchedule } from "./CreateBackupSchedule.ts";

/**
 * HTTP implementation of {@link CreateBackupSchedule}.
 *
 * @layer
 * @provides Stackit.Observability.CreateBackupSchedule
 */
export const CreateBackupScheduleHttp = Layer.effect(
  CreateBackupSchedule,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.CreateBackupSchedule",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.createBackupSchedule,
  }),
);
