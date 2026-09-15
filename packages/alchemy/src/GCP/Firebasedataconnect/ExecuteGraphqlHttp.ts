import * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
import * as Layer from "effect/Layer";
import { makeServiceHttpBinding } from "./BindingHttp.ts";
import { ExecuteGraphql } from "./ExecuteGraphql.ts";

/**
 * HTTP implementation of {@link ExecuteGraphql}.
 *
 * @layer
 * @provides GCP.Firebasedataconnect.ExecuteGraphql
 */
export const ExecuteGraphqlHttp = Layer.effect(
  ExecuteGraphql,
  makeServiceHttpBinding({
    tag: "GCP.Firebasedataconnect.ExecuteGraphql",
    operation: firebasedataconnect.executeGraphqlProjectsLocationsServices,
  }),
);
