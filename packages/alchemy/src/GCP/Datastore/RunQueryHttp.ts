import * as datastore from "@distilled.cloud/gcp/datastore_v1";
import * as Layer from "effect/Layer";
import { makeIndexeHttpBinding } from "./BindingHttp.ts";
import { RunQuery } from "./RunQuery.ts";

/**
 * HTTP implementation of {@link RunQuery}.
 *
 * @layer
 * @provides GCP.Datastore.RunQuery
 */
export const RunQueryHttp = Layer.effect(
  RunQuery,
  makeIndexeHttpBinding({
    tag: "GCP.Datastore.RunQuery",
    operation: datastore.runQueryProjects,
  }),
);
