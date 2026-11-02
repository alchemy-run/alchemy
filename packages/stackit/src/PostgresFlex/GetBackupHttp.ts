import * as postgres from "@distilled.cloud/stackit/postgres_flex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetBackup } from "./GetBackup.ts";

/**
 * HTTP implementation of {@link GetBackup}.
 *
 * @layer
 * @provides Stackit.PostgresFlex.GetBackup
 */
export const GetBackupHttp = Layer.effect(
  GetBackup,
  makeInstanceHttpBinding({
    tag: "Stackit.PostgresFlex.GetBackup",
    access: { permissions: ["postgres-flex.backup.get"] },
    operation: postgres.getBackup,
  }),
);
