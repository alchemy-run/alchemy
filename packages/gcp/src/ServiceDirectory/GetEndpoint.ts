import * as servicedirectory from "@distilled.cloud/gcp/servicedirectory_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEndpointHttpBinding } from "./BindingHttp.ts";
import type { Endpoint } from "./Endpoint.ts";

export interface GetEndpointRequest extends Omit<
  servicedirectory.GetProjectsLocationsNamespacesServicesEndpointsRequest,
  "name"
> {}

/**
 * Runtime binding for Service Directory `endpoints.get`.
 *
 * Bind this operation to an {@link Endpoint} in a Function/Action init
 * phase. Provide {@link GetEndpointHttp}.
 *
 * ### Reading an Endpoint
 * **Example:** Get the bound endpoint
 * ```typescript
 * const getEndpoint = yield* GCP.ServiceDirectory.GetEndpoint(api);
 * const live = yield* getEndpoint();
 * ```
 *
 * @binding
 * @category ServiceDirectory
 */
export interface GetEndpoint extends Binding.Service<
  GetEndpoint,
  "GCP.ServiceDirectory.GetEndpoint",
  (
    endpoint: Endpoint,
  ) => Effect.Effect<
    (
      request?: GetEndpointRequest,
    ) => Effect.Effect<
      servicedirectory.Endpoint,
      servicedirectory.GetProjectsLocationsNamespacesServicesEndpointsError,
      RuntimeContext
    >
  >
> {}

export const GetEndpoint = Binding.Service<GetEndpoint>("GCP.ServiceDirectory.GetEndpoint");

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
    iam: {
      role: "roles/servicedirectory.viewer",
      on: "servicedirectory.service",
    },
    operation: servicedirectory.getProjectsLocationsNamespacesServicesEndpoints,
  }),
);
