import * as appconfig from "@distilled.cloud/aws/appconfig";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type * as Effect from "effect/Effect";
import type { Application } from "./Application.ts";
import { makeAppConfigHttpBinding } from "./BindingHttp.ts";
import type { ConfigurationProfile } from "./ConfigurationProfile.ts";

export interface ValidateConfigurationRequest extends Omit<
  appconfig.ValidateConfigurationRequest,
  "ApplicationId" | "ConfigurationProfileId"
> {}

/**
 * Validate a configuration version against a configuration profile's
 * validators from a Lambda (or other AWS runtime). Pairs with
 * {@link CreateHostedConfigurationVersion} + {@link StartDeployment}: write
 * the new content, validate it, then roll it out. Fails with a typed
 * `BadRequestException` when a validator rejects the content; succeeds with
 * an empty response when validation passes (including when the profile has
 * no validators).
 *
 * Provide `AppConfig.ValidateConfigurationHttp` on the hosting function's
 * Effect to implement the binding.
 *
 * ### Writing Configuration at Runtime
 * **Example:** Validate a version before deploying it
 * ```typescript
 * const validate = yield* AppConfig.ValidateConfiguration(app, profile);
 * yield* validate({ ConfigurationVersion: "2" });
 * ```
 *
 * @binding
 */
export interface ValidateConfiguration extends Binding.Service<
  ValidateConfiguration,
  "AWS.AppConfig.ValidateConfiguration",
  (
    application: Application,
    configurationProfile: ConfigurationProfile,
  ) => Effect.Effect<
    (
      request: ValidateConfigurationRequest,
    ) => Effect.Effect<
      appconfig.ValidateConfigurationResponse,
      appconfig.ValidateConfigurationError
    >
  >
> {}
export const ValidateConfiguration = Binding.Service<ValidateConfiguration>(
  "AWS.AppConfig.ValidateConfiguration",
);

/**
 * HTTP implementation of the {@link ValidateConfiguration} binding. Calls
 * `appconfig:ValidateConfiguration` with the Lambda's IAM role, scoped to
 * the bound configuration profile.
 */
export const ValidateConfigurationHttp = makeAppConfigHttpBinding(ValidateConfiguration, {
  operation: appconfig.validateConfiguration,
  spec: (application: Application, configurationProfile: ConfigurationProfile) => ({
    identifiers: {
      ApplicationId: application.applicationId,
      ConfigurationProfileId: configurationProfile.configurationProfileId,
    },
    // The service authorization reference lists configurationprofile +
    // hostedconfigurationversion, but the LIVE authorizer evaluates the
    // APPLICATION ARN (CloudTrail: "not authorized to perform:
    // appconfig:ValidateConfiguration on resource: ...:application/{id}").
    // Grant all three.
    iam: ({ region, accountId }) => ({
      actions: ["appconfig:ValidateConfiguration"],
      resources: [
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}`,
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}/configurationprofile/${configurationProfile.configurationProfileId}`,
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}/configurationprofile/${configurationProfile.configurationProfileId}/hostedconfigurationversion/*`,
      ],
    }),
  }),
});
