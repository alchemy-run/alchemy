import * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
import * as Layer from "effect/Layer";
import { makeConnectorHttpBinding } from "./BindingHttp.ts";
import { ExecuteMutation } from "./ExecuteMutation.ts";

/**
 * HTTP implementation of {@link ExecuteMutation}.
 *
 * @layer
 * @provides GCP.Firebasedataconnect.ExecuteMutation
 */
export const ExecuteMutationHttp = Layer.effect(
  ExecuteMutation,
  makeConnectorHttpBinding({
    tag: "GCP.Firebasedataconnect.ExecuteMutation",
    operation:
      firebasedataconnect.executeMutationProjectsLocationsServicesConnectors,
  }),
);
