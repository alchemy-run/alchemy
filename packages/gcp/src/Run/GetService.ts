import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import type { Service } from "./Service.ts";

export interface GetServiceRequest extends Omit<
  cloudrun.GetProjectsLocationsServicesRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Run `services.get`.
 *
 * Bind this operation to a {@link Service} in a Function/Action init phase.
 * Provide {@link GetServiceHttp}.
 *
 * ### Reading a Service
 * **Example:** Get the bound service
 * ```typescript
 * const getService = yield* GCP.Run.GetService(api);
 * const live = yield* getService();
 * ```
 *
 * @binding
 * @category Run
 */
export interface GetService extends Binding.Service<
  GetService,
  "GCP.Run.GetService",
  (
    service: Service,
  ) => Effect.Effect<
    (
      request?: GetServiceRequest,
    ) => Effect.Effect<
      cloudrun.GoogleCloudRunV2Service,
      cloudrun.GetProjectsLocationsServicesError,
      RuntimeContext
    >
  >
> {}

export const GetService = Binding.Service<GetService>("GCP.Run.GetService");

/**
 * HTTP implementation of {@link GetService}.
 *
 * @layer
 * @provides GCP.Run.GetService
 */
export const GetServiceHttp = Layer.effect(
  GetService,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const get = yield* GCPBindings.withCredentials(cloudrun.getProjectsLocationsServices);
    return Effect.fn(function* <T extends Service>(service: T) {
      const name = yield* service.name;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.Run.GetService(${service})`({
          iam: [grantFor({ role: "roles/run.viewer", on: "run.service" }, service.name)],
        });
      }
      return Effect.fn(`GCP.Run.GetService(${service.LogicalId})`)(function* (
        request?: GetServiceRequest,
      ) {
        return yield* get({
          ...request,
          name: yield* name,
        });
      });
    });
  }),
);
