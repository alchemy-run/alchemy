import * as mariadb from "@distilled.cloud/stackit/mariadb";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListCredentials } from "./ListCredentials.ts";

/**
 * HTTP implementation of {@link ListCredentials}.
 *
 * @layer
 * @provides Stackit.MariaDB.ListCredentials
 */
export const ListCredentialsHttp = Layer.effect(
  ListCredentials,
  makeInstanceHttpBinding({
    tag: "Stackit.MariaDB.ListCredentials",
    permission: "mariadb.credential.list",
    operation: mariadb.listCredentials,
  }),
);
