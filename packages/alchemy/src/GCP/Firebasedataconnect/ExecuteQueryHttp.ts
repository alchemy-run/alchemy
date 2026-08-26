import * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
import * as Layer from "effect/Layer";
import { makeConnectorHttpBinding } from "./BindingHttp.ts";
import { ExecuteQuery } from "./ExecuteQuery.ts";

/**
 * HTTP implementation of {@link ExecuteQuery}.
 *
 * @layer
 * @provides GCP.Firebasedataconnect.ExecuteQuery
 */
export const ExecuteQueryHttp = Layer.effect(
  ExecuteQuery,
  makeConnectorHttpBinding({
    tag: "GCP.Firebasedataconnect.ExecuteQuery",
    operation:
      firebasedataconnect.executeQueryProjectsLocationsServicesConnectors,
  }),
);
