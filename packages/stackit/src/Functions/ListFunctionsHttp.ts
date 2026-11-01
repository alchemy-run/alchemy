import * as functions from "@distilled.cloud/stackit/functions";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding } from "./BindingHttp.ts";
import { ListFunctions } from "./ListFunctions.ts";

/**
 * HTTP implementation of {@link ListFunctions}.
 *
 * @layer
 * @provides Stackit.Functions.ListFunctions
 */
export const ListFunctionsHttp = Layer.effect(
  ListFunctions,
  makeProjectHttpBinding({
    tag: "Stackit.Functions.ListFunctions",
    permissions: ["functions.function.list"],
    operation: functions.listFunctions,
  }),
);
