import * as mariadb from "@distilled.cloud/stackit/mariadb";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { CreateBackup } from "./CreateBackup.ts";

/**
 * HTTP implementation of {@link CreateBackup}.
 *
 * @layer
 * @provides Stackit.MariaDB.CreateBackup
 */
export const CreateBackupHttp = Layer.effect(
  CreateBackup,
  makeInstanceHttpBinding({
    tag: "Stackit.MariaDB.CreateBackup",
    permission: "mariadb.proxy.write",
    operation: mariadb.createBackup,
  }),
);
