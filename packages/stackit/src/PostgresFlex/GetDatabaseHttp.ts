import * as postgres from "@distilled.cloud/stackit/postgres_flex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetDatabase } from "./GetDatabase.ts";

/**
 * HTTP implementation of {@link GetDatabase}.
 *
 * @layer
 * @provides Stackit.PostgresFlex.GetDatabase
 */
export const GetDatabaseHttp = Layer.effect(
  GetDatabase,
  makeInstanceHttpBinding({
    tag: "Stackit.PostgresFlex.GetDatabase",
    access: { permissions: ["postgres-flex.database.get"] },
    operation: postgres.getDatabase,
  }),
);
