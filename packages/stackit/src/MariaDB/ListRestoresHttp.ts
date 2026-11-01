import * as mariadb from "@distilled.cloud/stackit/mariadb";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListRestores } from "./ListRestores.ts";

/**
 * HTTP implementation of {@link ListRestores}.
 *
 * @layer
 * @provides Stackit.MariaDB.ListRestores
 */
export const ListRestoresHttp = Layer.effect(
  ListRestores,
  makeInstanceHttpBinding({
    tag: "Stackit.MariaDB.ListRestores",
    permission: "mariadb.proxy.read",
    operation: mariadb.listRestores,
  }),
);
