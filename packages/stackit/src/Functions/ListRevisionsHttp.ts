import * as functions from "@distilled.cloud/stackit/functions";
import * as Layer from "effect/Layer";
import { makeFunctionHttpBinding } from "./BindingHttp.ts";
import { ListRevisions } from "./ListRevisions.ts";

/**
 * HTTP implementation of {@link ListRevisions}.
 *
 * @layer
 * @provides Stackit.Functions.ListRevisions
 */
export const ListRevisionsHttp = Layer.effect(
  ListRevisions,
  makeFunctionHttpBinding({
    tag: "Stackit.Functions.ListRevisions",
    permissions: ["functions.revision.list"],
    operation: functions.listRevisions,
  }),
);
