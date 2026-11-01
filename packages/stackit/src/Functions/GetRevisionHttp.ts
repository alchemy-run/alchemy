import * as functions from "@distilled.cloud/stackit/functions";
import * as Layer from "effect/Layer";
import { makeFunctionHttpBinding } from "./BindingHttp.ts";
import { GetRevision } from "./GetRevision.ts";

/**
 * HTTP implementation of {@link GetRevision}.
 *
 * @layer
 * @provides Stackit.Functions.GetRevision
 */
export const GetRevisionHttp = Layer.effect(
  GetRevision,
  makeFunctionHttpBinding({
    tag: "Stackit.Functions.GetRevision",
    permissions: ["functions.revision.get"],
    operation: functions.getRevision,
  }),
);
