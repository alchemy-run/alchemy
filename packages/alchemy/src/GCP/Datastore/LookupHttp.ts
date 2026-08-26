import * as datastore from "@distilled.cloud/gcp/datastore_v1";
import * as Layer from "effect/Layer";
import { makeIndexeHttpBinding } from "./BindingHttp.ts";
import { Lookup } from "./Lookup.ts";

/**
 * HTTP implementation of {@link Lookup}.
 *
 * @layer
 * @provides GCP.Datastore.Lookup
 */
export const LookupHttp = Layer.effect(
  Lookup,
  makeIndexeHttpBinding({
    tag: "GCP.Datastore.Lookup",
    operation: datastore.lookupProjects,
  }),
);
