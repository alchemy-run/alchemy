import * as valkey from "@distilled.cloud/stackit/valkey";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { CreateBackup } from "./CreateBackup.ts";

/**
 * HTTP implementation of {@link CreateBackup}.
 *
 * @layer
 * @provides Stackit.Valkey.CreateBackup
 */
export const CreateBackupHttp = Layer.effect(
  CreateBackup,
  makeInstanceHttpBinding({
    tag: "Stackit.Valkey.CreateBackup",
    permission: "key-value-store.proxy.write",
    operation: valkey.createBackup,
  }),
);
