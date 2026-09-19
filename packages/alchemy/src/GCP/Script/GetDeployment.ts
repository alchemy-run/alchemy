import type * as script from "@distilled.cloud/gcp/script_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Deployment } from "./Deployment.ts";

export interface GetDeploymentRequest extends Omit<
  script.GetProjectsDeploymentsRequest,
  "scriptId" | "deploymentId"
> {}

/**
 * Runtime binding for Apps Script `projects.deployments.get`.
 *
 * Bind this operation to a {@link Deployment} in a Function/Action
 * init phase. Provide {@link GetDeploymentHttp}.
 *
 * ### Reading Deployments
 * **Example:** Read deployment metadata
 * ```typescript
 * const getDeployment = yield* GCP.Script.GetDeployment(deployment);
 * const live = yield* getDeployment({});
 * ```
 *
 * @binding
 * @product GCP
 * @category Script
 */
export interface GetDeployment extends Binding.Service<
  GetDeployment,
  "GCP.Script.GetDeployment",
  (
    deployment: Deployment,
  ) => Effect.Effect<
    (
      request: GetDeploymentRequest,
    ) => Effect.Effect<
      script.Deployment,
      script.GetProjectsDeploymentsError,
      RuntimeContext
    >
  >
> {}

export const GetDeployment = Binding.Service<GetDeployment>(
  "GCP.Script.GetDeployment",
);
