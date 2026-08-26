import * as datastore from "@distilled.cloud/gcp/datastore_v1";
import * as Layer from "effect/Layer";
import { makeIndexeHttpBinding } from "./BindingHttp.ts";
import { Commit } from "./Commit.ts";

/**
 * HTTP implementation of {@link Commit}.
 *
 * @layer
 * @provides GCP.Datastore.Commit
 */
export const CommitHttp = Layer.effect(
  Commit,
  makeIndexeHttpBinding({
    tag: "GCP.Datastore.Commit",
    operation: datastore.commitProjects,
  }),
);
