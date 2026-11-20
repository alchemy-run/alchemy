import * as appconfig from "@distilled.cloud/aws/appconfig";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type * as Effect from "effect/Effect";
import type { Application } from "./Application.ts";
import { makeAppConfigHttpBinding } from "./BindingHttp.ts";
import type { ConfigurationProfile } from "./ConfigurationProfile.ts";
import type { DeploymentStrategy } from "./DeploymentStrategy.ts";
import type { Environment } from "./Environment.ts";

export interface StartDeploymentRequest extends Omit<
  appconfig.StartDeploymentRequest,
  "ApplicationId" | "EnvironmentId" | "ConfigurationProfileId" | "DeploymentStrategyId"
> {}

/**
 * Start an AppConfig deployment from a Lambda (or other AWS runtime) — roll a
 * configuration version out to an environment following a deployment
 * strategy. Pairs with {@link CreateHostedConfigurationVersion} to build
 * runtime feature-flag/configuration management services.
 *
 * Provide `AppConfig.StartDeploymentHttp` on the hosting function's Effect to
 * implement the binding.
 *
 * ### Deploying Configuration at Runtime
 * **Example:** Roll out a configuration version
 * ```typescript
 * const startDeployment = yield* AppConfig.StartDeployment(
 *   app,
 *   env,
 *   profile,
 *   strategy,
 * );
 * const deployment = yield* startDeployment({
 *   ConfigurationVersion: "2",
 * });
 * // deployment.DeploymentNumber, deployment.State ("DEPLOYING", ...)
 * ```
 *
 * @binding
 */
export interface StartDeployment extends Binding.Service<
  StartDeployment,
  "AWS.AppConfig.StartDeployment",
  (
    application: Application,
    environment: Environment,
    configurationProfile: ConfigurationProfile,
    deploymentStrategy: DeploymentStrategy,
  ) => Effect.Effect<
    (
      request: StartDeploymentRequest,
    ) => Effect.Effect<appconfig.Deployment, appconfig.StartDeploymentError>
  >
> {}
export const StartDeployment = Binding.Service<StartDeployment>("AWS.AppConfig.StartDeployment");

/**
 * HTTP implementation of the {@link StartDeployment} binding. Calls
 * `appconfig:StartDeployment` with the Lambda's IAM role, scoped to the bound
 * application, environment, configuration profile, and deployment strategy.
 */
export const StartDeploymentHttp = makeAppConfigHttpBinding(StartDeployment, {
  operation: appconfig.startDeployment,
  spec: (
    application: Application,
    environment: Environment,
    configurationProfile: ConfigurationProfile,
    deploymentStrategy: DeploymentStrategy,
  ) => ({
    identifiers: {
      ApplicationId: application.applicationId,
      EnvironmentId: environment.environmentId,
      ConfigurationProfileId: configurationProfile.configurationProfileId,
      DeploymentStrategyId: deploymentStrategy.deploymentStrategyId,
    },
    iam: ({ region, accountId }) => ({
      actions: ["appconfig:StartDeployment"],
      resources: [
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}`,
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}/environment/${environment.environmentId}`,
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}/configurationprofile/${configurationProfile.configurationProfileId}`,
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:deploymentstrategy/${deploymentStrategy.deploymentStrategyId}`,
      ],
    }),
  }),
});
