import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAppIntegrationsHttpBinding } from "./BindingHttp.ts";
import type { DataIntegration } from "./DataIntegration.ts";

export interface CreateDataIntegrationAssociationRequest extends Omit<
  appintegrations.CreateDataIntegrationAssociationRequest,
  "DataIntegrationIdentifier"
> {}

/**
 * Associates a client (identified by `ClientId` / `ClientAssociationMetadata`)
 * with an AppIntegrations {@link DataIntegration}
 * (`app-integrations:CreateDataIntegrationAssociation`). Associations have no
 * independent delete API — they live and die with the data integration — so
 * they are exposed as a runtime binding rather than a Resource.
 *
 * Provide the `CreateDataIntegrationAssociationHttp` layer on the Function to
 * satisfy the binding.
 * ### Creating Data Integration Associations
 * **Example:** Associate a Client with a Data Integration
 * ```typescript
 * // init (provide AWS.AppIntegrations.CreateDataIntegrationAssociationHttp on the Function)
 * const createDataIntegrationAssociation =
 *   yield* AWS.AppIntegrations.CreateDataIntegrationAssociation(integration);
 *
 * // runtime — the DataIntegrationIdentifier is injected automatically
 * const { DataIntegrationAssociationId } =
 *   yield* createDataIntegrationAssociation({
 *     ClientId: "my-client",
 *     ClientAssociationMetadata: { purpose: "sync" },
 *   });
 * ```
 *
 * @binding
 */
export interface CreateDataIntegrationAssociation extends Binding.Service<
  CreateDataIntegrationAssociation,
  "AWS.AppIntegrations.CreateDataIntegrationAssociation",
  <R extends DataIntegration>(
    integration: R,
  ) => Effect.Effect<
    (
      request?: CreateDataIntegrationAssociationRequest,
    ) => Effect.Effect<
      appintegrations.CreateDataIntegrationAssociationResponse,
      appintegrations.CreateDataIntegrationAssociationError
    >
  >
> {}
export const CreateDataIntegrationAssociation = Binding.Service<CreateDataIntegrationAssociation>(
  "AWS.AppIntegrations.CreateDataIntegrationAssociation",
);

/**
 * HTTP implementation of {@link CreateDataIntegrationAssociation}. At deploy
 * time it grants `app-integrations:CreateDataIntegrationAssociation` on the
 * data integration (and its `data-integration-association/*` children); at
 * runtime it calls the AppIntegrations API with the host Function's
 * credentials, injecting the data integration's id. Provide this layer on
 * the Function using the binding.
 */
export const CreateDataIntegrationAssociationHttp = Layer.effect(
  CreateDataIntegrationAssociation,
  makeAppIntegrationsHttpBinding({
    name: "CreateDataIntegrationAssociation",
    operation: appintegrations.createDataIntegrationAssociation,
    requestKey: "DataIntegrationIdentifier",
    identifier: (integration: DataIntegration) => integration.dataIntegrationId,
    iamActions: ["app-integrations:CreateDataIntegrationAssociation"],
    resources: (integration, { region, accountId }) => [
      Output.interpolate`${integration.dataIntegrationArn}`,
      Output.interpolate`arn:aws:app-integrations:${region}:${accountId}:data-integration-association/${integration.dataIntegrationId}/*`,
    ],
    // AppIntegrations provisions an AppFlow flow (and Customer Profiles
    // snapshots) on the caller's behalf when an association is created.
    dependentActions: [
      "appflow:CreateFlow",
      "appflow:DeleteFlow",
      "appflow:DescribeConnectorEntity",
      "appflow:DescribeConnectorProfiles",
      "appflow:TagResource",
      "appflow:UseConnectorProfile",
      "profile:CreateSnapshot",
      "profile:GetSnapshot",
    ],
  }),
);
