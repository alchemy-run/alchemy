import * as servicedirectory from "@distilled.cloud/gcp/servicedirectory_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import type { Service } from "./Service.ts";

export interface ResolveRequest extends Omit<
  servicedirectory.ResolveProjectsLocationsNamespacesServicesRequest,
  "name"
> {}

/**
 * Runtime binding for Service Directory `services.resolve`.
 *
 * Looks up a {@link Service} and its endpoints. Bind this operation in a
 * Function/Action init phase. Provide {@link ResolveHttp}.
 *
 * ### Resolving a Service
 * **Example:** Resolve endpoints
 * ```typescript
 * const resolve = yield* GCP.ServiceDirectory.Resolve(api);
 * const { service } = yield* resolve();
 * ```
 *
 * **Example:** Filter endpoints
 * ```typescript
 * const { service } = yield* resolve({
 *   body: { endpointFilter: "port>8080", maxEndpoints: 10 },
 * });
 * ```
 *
 * @binding
 * @category ServiceDirectory
 */
export interface Resolve extends Binding.Service<
  Resolve,
  "GCP.ServiceDirectory.Resolve",
  (
    service: Service,
  ) => Effect.Effect<
    (
      request?: ResolveRequest,
    ) => Effect.Effect<
      servicedirectory.ResolveServiceResponse,
      servicedirectory.ResolveProjectsLocationsNamespacesServicesError,
      RuntimeContext
    >
  >
> {}

export const Resolve = Binding.Service<Resolve>("GCP.ServiceDirectory.Resolve");

/**
 * HTTP implementation of {@link Resolve}.
 *
 * @layer
 * @provides GCP.ServiceDirectory.Resolve
 */
export const ResolveHttp = Layer.effect(
  Resolve,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const resolveProjectsLocationsNamespacesServices = yield* GCPBindings.withCredentials(
      servicedirectory.resolveProjectsLocationsNamespacesServices,
    );
    return Effect.fn(function* <S extends Service>(service: S) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.ServiceDirectory.Resolve(${service})`({
          iam: [
            grantFor(
              {
                role: "roles/servicedirectory.viewer",
                on: "servicedirectory.service",
              },
              service.name,
            ),
          ],
        });
      }
      const name = yield* service.name;
      return Effect.fn(`GCP.ServiceDirectory.Resolve(${service.LogicalId})`)(function* (
        request?: ResolveRequest,
      ) {
        return yield* resolveProjectsLocationsNamespacesServices({
          ...request,
          name: yield* name,
        });
      });
    });
  }),
);
