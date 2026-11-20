import * as composer from "@distilled.cloud/gcp/composer_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEnvironmentHttpBinding } from "./BindingHttp.ts";
import type { Environment } from "./Environment.ts";

export interface GetEnvironmentRequest extends Omit<
  composer.GetProjectsLocationsEnvironmentsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Composer `environments.get`.
 *
 * Bind this operation to an {@link Environment} in a Function/Action init
 * phase. Provide {@link GetEnvironmentHttp}.
 *
 * ### Observing Environments
 * **Example:** Read the bound environment
 * ```typescript
 * const getEnvironment = yield* GCP.Composer.GetEnvironment(airflow);
 * const live = yield* getEnvironment();
 * ```
 *
 * @binding
 * @category Composer
 */
export interface GetEnvironment extends Binding.Service<
  GetEnvironment,
  "GCP.Composer.GetEnvironment",
  (
    environment: Environment,
  ) => Effect.Effect<
    (
      request?: GetEnvironmentRequest,
    ) => Effect.Effect<
      composer.Environment,
      composer.GetProjectsLocationsEnvironmentsError,
      RuntimeContext
    >
  >
> {}

export const GetEnvironment = Binding.Service<GetEnvironment>("GCP.Composer.GetEnvironment");

/**
 * HTTP implementation of {@link GetEnvironment}.
 *
 * @layer
 * @provides GCP.Composer.GetEnvironment
 */
export const GetEnvironmentHttp = Layer.effect(
  GetEnvironment,
  makeEnvironmentHttpBinding({
    tag: "GCP.Composer.GetEnvironment",
    iam: { role: "roles/composer.viewer" },
    nameKey: "name",
    operation: composer.getProjectsLocationsEnvironments,
  }),
);
