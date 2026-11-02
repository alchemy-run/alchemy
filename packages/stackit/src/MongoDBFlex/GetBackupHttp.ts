import * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetBackup } from "./GetBackup.ts";

/**
 * HTTP implementation of {@link GetBackup}.
 *
 * @layer
 * @provides Stackit.MongoDBFlex.GetBackup
 */
export const GetBackupHttp = Layer.effect(
  GetBackup,
  makeInstanceHttpBinding({
    tag: "Stackit.MongoDBFlex.GetBackup",
    access: { permissions: ["mongodb-flex.backup.get"] },
    operation: mongodb.getBackup,
  }),
);
