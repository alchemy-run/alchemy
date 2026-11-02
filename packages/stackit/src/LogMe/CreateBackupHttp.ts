import * as logme from "@distilled.cloud/stackit/logme";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { CreateBackup } from "./CreateBackup.ts";

/**
 * HTTP implementation of {@link CreateBackup}.
 *
 * @layer
 * @provides Stackit.LogMe.CreateBackup
 */
export const CreateBackupHttp = Layer.effect(
  CreateBackup,
  makeInstanceHttpBinding({
    tag: "Stackit.LogMe.CreateBackup",
    permission: "logme.proxy.write",
    operation: logme.createBackup,
  }),
);
