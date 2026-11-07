import * as appconfig from "@distilled.cloud/aws/appconfig";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type * as Effect from "effect/Effect";
import type { Application } from "./Application.ts";
import { makeAppConfigHttpBinding } from "./BindingHttp.ts";
import type { Environment } from "./Environment.ts";

export interface StopDeploymentRequest extends Omit<
  appconfig.StopDeploymentRequest,
  "ApplicationId" | "EnvironmentId"
> {}

/**
 * Stop (or revert) an AppConfig deployment from a Lambda (or other AWS
 * runtime). Stopping an in-progress rollout rolls it back; with
 * `AllowRevert: true` a completed deployment can be reverted within 72
 * hours.
 *
 * Provide `AppConfig.StopDeploymentHttp` on the hosting function's Effect to
 * implement the binding.
 *
 * ### Deploying Configuration at Runtime
 * **Example:** Roll back an in-progress rollout
 * ```typescript
 * const stopDeployment = yield* AppConfig.StopDeployment(app, env);
 * yield* stopDeployment({ DeploymentNumber: 2 });
 * ```
 *
 * @binding
 */
export interface StopDeployment extends Binding.Service<
  StopDeployment,
  "AWS.AppConfig.StopDeployment",
  (
    application: Application,
    environment: Environment,
  ) => Effect.Effect<
    (
      request: StopDeploymentRequest,
    ) => Effect.Effect<appconfig.Deployment, appconfig.StopDeploymentError>
  >
> {}
export const StopDeployment = Binding.Service<StopDeployment>("AWS.AppConfig.StopDeployment");

/**
 * HTTP implementation of the {@link StopDeployment} binding. Calls
 * `appconfig:StopDeployment` with the Lambda's IAM role, scoped to the bound
 * environment's deployments.
 */
export const StopDeploymentHttp = makeAppConfigHttpBinding(StopDeployment, {
  operation: appconfig.stopDeployment,
  spec: (application: Application, environment: Environment) => ({
    identifiers: {
      ApplicationId: application.applicationId,
      EnvironmentId: environment.environmentId,
    },
    // The live authorizer evaluates the parent container ARNs (application,
    // environment) in addition to the deployment — observed via CloudTrail.
    iam: ({ region, accountId }) => ({
      actions: ["appconfig:StopDeployment"],
      resources: [
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}`,
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}/environment/${environment.environmentId}`,
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}/environment/${environment.environmentId}/deployment/*`,
      ],
    }),
  }),
});
