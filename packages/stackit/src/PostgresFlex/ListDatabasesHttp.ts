import * as postgres from "@distilled.cloud/stackit/postgres_flex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListDatabases } from "./ListDatabases.ts";

/**
 * HTTP implementation of {@link ListDatabases}.
 *
 * @layer
 * @provides Stackit.PostgresFlex.ListDatabases
 */
export const ListDatabasesHttp = Layer.effect(
  ListDatabases,
  makeInstanceHttpBinding({
    tag: "Stackit.PostgresFlex.ListDatabases",
    access: { permissions: ["postgres-flex.database.list"] },
    operation: postgres.listDatabases,
  }),
);
