import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { RestoreBackup } from "./RestoreBackup.ts";

/**
 * HTTP implementation of {@link RestoreBackup}.
 *
 * @layer
 * @provides Stackit.Observability.RestoreBackup
 */
export const RestoreBackupHttp = Layer.effect(
  RestoreBackup,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.RestoreBackup",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.restoreBackup,
  }),
);
