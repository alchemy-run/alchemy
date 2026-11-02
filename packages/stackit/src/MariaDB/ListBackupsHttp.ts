import * as mariadb from "@distilled.cloud/stackit/mariadb";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListBackups } from "./ListBackups.ts";

/**
 * HTTP implementation of {@link ListBackups}.
 *
 * @layer
 * @provides Stackit.MariaDB.ListBackups
 */
export const ListBackupsHttp = Layer.effect(
  ListBackups,
  makeInstanceHttpBinding({
    tag: "Stackit.MariaDB.ListBackups",
    permission: "mariadb.proxy.read",
    operation: mariadb.listBackups,
  }),
);
