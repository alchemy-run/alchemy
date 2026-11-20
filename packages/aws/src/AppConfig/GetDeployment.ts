import * as appconfig from "@distilled.cloud/aws/appconfig";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type * as Effect from "effect/Effect";
import type { Application } from "./Application.ts";
import { makeAppConfigHttpBinding } from "./BindingHttp.ts";
import type { Environment } from "./Environment.ts";

export interface GetDeploymentRequest extends Omit<
  appconfig.GetDeploymentRequest,
  "ApplicationId" | "EnvironmentId"
> {}

/**
 * Read an AppConfig deployment's status from a Lambda (or other AWS runtime)
 * — poll a rollout started with {@link StartDeployment} until it reaches a
 * terminal state (`COMPLETE`, `ROLLED_BACK`, `REVERTED`).
 *
 * Provide `AppConfig.GetDeploymentHttp` on the hosting function's Effect to
 * implement the binding.
 *
 * ### Deploying Configuration at Runtime
 * **Example:** Check a rollout's progress
 * ```typescript
 * const getDeployment = yield* AppConfig.GetDeployment(app, env);
 * const deployment = yield* getDeployment({ DeploymentNumber: 2 });
 * // deployment.State, deployment.PercentageComplete
 * ```
 *
 * @binding
 */
export interface GetDeployment extends Binding.Service<
  GetDeployment,
  "AWS.AppConfig.GetDeployment",
  (
    application: Application,
    environment: Environment,
  ) => Effect.Effect<
    (
      request: GetDeploymentRequest,
    ) => Effect.Effect<appconfig.Deployment, appconfig.GetDeploymentError>
  >
> {}
export const GetDeployment = Binding.Service<GetDeployment>("AWS.AppConfig.GetDeployment");

/**
 * HTTP implementation of the {@link GetDeployment} binding. Calls
 * `appconfig:GetDeployment` with the Lambda's IAM role, scoped to the bound
 * environment's deployments.
 */
export const GetDeploymentHttp = makeAppConfigHttpBinding(GetDeployment, {
  operation: appconfig.getDeployment,
  spec: (application: Application, environment: Environment) => ({
    identifiers: {
      ApplicationId: application.applicationId,
      EnvironmentId: environment.environmentId,
    },
    // The live authorizer evaluates the parent container ARNs (application,
    // environment) in addition to the deployment — observed via CloudTrail.
    iam: ({ region, accountId }) => ({
      actions: ["appconfig:GetDeployment"],
      resources: [
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}`,
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}/environment/${environment.environmentId}`,
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}/environment/${environment.environmentId}/deployment/*`,
      ],
    }),
  }),
});
