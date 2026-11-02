import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListDatabases } from "./ListDatabases.ts";

/**
 * HTTP implementation of {@link ListDatabases}.
 *
 * @layer
 * @provides Stackit.SQLServerFlex.ListDatabases
 */
export const ListDatabasesHttp = Layer.effect(
  ListDatabases,
  makeInstanceHttpBinding({
    tag: "Stackit.SQLServerFlex.ListDatabases",
    access: { permissions: ["sqlserver-flex.database.list"] },
    operation: sqlserver.listDatabases,
  }),
);
