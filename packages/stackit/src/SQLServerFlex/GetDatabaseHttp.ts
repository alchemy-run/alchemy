import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetDatabase } from "./GetDatabase.ts";

/**
 * HTTP implementation of {@link GetDatabase}.
 *
 * @layer
 * @provides Stackit.SQLServerFlex.GetDatabase
 */
export const GetDatabaseHttp = Layer.effect(
  GetDatabase,
  makeInstanceHttpBinding({
    tag: "Stackit.SQLServerFlex.GetDatabase",
    access: { permissions: ["sqlserver-flex.database.get"] },
    operation: sqlserver.getDatabase,
  }),
);
