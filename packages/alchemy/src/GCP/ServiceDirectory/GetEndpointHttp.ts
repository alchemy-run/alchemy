import * as servicedirectory from "@distilled.cloud/gcp/servicedirectory_v1";
import * as Layer from "effect/Layer";
import { makeEndpointHttpBinding } from "./BindingHttp.ts";
import { GetEndpoint } from "./GetEndpoint.ts";

/**
 * HTTP implementation of {@link GetEndpoint}.
 *
 * @layer
 * @provides GCP.ServiceDirectory.GetEndpoint
 */
export const GetEndpointHttp = Layer.effect(
  GetEndpoint,
  makeEndpointHttpBinding({
    tag: "GCP.ServiceDirectory.GetEndpoint",
    operation: servicedirectory.getProjectsLocationsNamespacesServicesEndpoints,
  }),
);
