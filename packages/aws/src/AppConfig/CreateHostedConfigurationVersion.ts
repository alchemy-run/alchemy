import * as appconfig from "@distilled.cloud/aws/appconfig";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type * as Effect from "effect/Effect";
import type { Application } from "./Application.ts";
import { makeAppConfigHttpBinding } from "./BindingHttp.ts";
import type { ConfigurationProfile } from "./ConfigurationProfile.ts";

export interface CreateHostedConfigurationVersionRequest extends Omit<
  appconfig.CreateHostedConfigurationVersionRequest,
  "ApplicationId" | "ConfigurationProfileId"
> {}

/**
 * Write a new configuration version to the AppConfig hosted store from a
 * Lambda (or other AWS runtime). Pairs with {@link StartDeployment} to build
 * runtime feature-flag/configuration management services: write the new
 * content, then roll it out.
 *
 * Provide `AppConfig.CreateHostedConfigurationVersionHttp` on the hosting
 * function's Effect to implement the binding.
 *
 * ### Writing Configuration at Runtime
 * **Example:** Store a new configuration version
 * ```typescript
 * const createVersion = yield* AppConfig.CreateHostedConfigurationVersion(
 *   app,
 *   profile,
 * );
 * const version = yield* createVersion({
 *   Content: JSON.stringify({ featureX: false }),
 *   ContentType: "application/json",
 * });
 * // version.VersionNumber -> 2
 * ```
 *
 * @binding
 */
export interface CreateHostedConfigurationVersion extends Binding.Service<
  CreateHostedConfigurationVersion,
  "AWS.AppConfig.CreateHostedConfigurationVersion",
  (
    application: Application,
    configurationProfile: ConfigurationProfile,
  ) => Effect.Effect<
    (
      request: CreateHostedConfigurationVersionRequest,
    ) => Effect.Effect<
      appconfig.HostedConfigurationVersion,
      appconfig.CreateHostedConfigurationVersionError
    >
  >
> {}
export const CreateHostedConfigurationVersion = Binding.Service<CreateHostedConfigurationVersion>(
  "AWS.AppConfig.CreateHostedConfigurationVersion",
);

/**
 * HTTP implementation of the {@link CreateHostedConfigurationVersion}
 * binding. Calls `appconfig:CreateHostedConfigurationVersion` with the
 * Lambda's IAM role, scoped to the bound configuration profile and its
 * hosted versions.
 */
export const CreateHostedConfigurationVersionHttp = makeAppConfigHttpBinding(
  CreateHostedConfigurationVersion,
  {
    operation: appconfig.createHostedConfigurationVersion,
    spec: (application: Application, configurationProfile: ConfigurationProfile) => ({
      identifiers: {
        ApplicationId: application.applicationId,
        ConfigurationProfileId: configurationProfile.configurationProfileId,
      },
      // Per the service authorization reference, the action is authorized
      // against BOTH the application and the configuration profile.
      iam: ({ region, accountId }) => ({
        actions: ["appconfig:CreateHostedConfigurationVersion"],
        resources: [
          Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}`,
          Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}/configurationprofile/${configurationProfile.configurationProfileId}`,
          Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}/configurationprofile/${configurationProfile.configurationProfileId}/hostedconfigurationversion/*`,
        ],
      }),
    }),
  },
);
