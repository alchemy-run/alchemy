import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAppIntegrationsHttpBinding } from "./BindingHttp.ts";
import type { DataIntegration } from "./DataIntegration.ts";

export interface UpdateDataIntegrationAssociationRequest extends Omit<
  appintegrations.UpdateDataIntegrationAssociationRequest,
  "DataIntegrationIdentifier"
> {}

/**
 * Updates an association of an AppIntegrations {@link DataIntegration}
 * (`app-integrations:UpdateDataIntegrationAssociation`). Updating an
 * association with an `ON_DEMAND` `ExecutionConfiguration` reruns the
 * on-demand data-pull job — this is the data-plane trigger for pulling
 * source data again.
 *
 * Provide the `UpdateDataIntegrationAssociationHttp` layer on the Function to
 * satisfy the binding.
 * ### Updating Data Integration Associations
 * **Example:** Rerun an On-Demand Data Pull
 * ```typescript
 * // init (provide AWS.AppIntegrations.UpdateDataIntegrationAssociationHttp on the Function)
 * const updateDataIntegrationAssociation =
 *   yield* AWS.AppIntegrations.UpdateDataIntegrationAssociation(integration);
 *
 * // runtime — the DataIntegrationIdentifier is injected automatically
 * yield* updateDataIntegrationAssociation({
 *   DataIntegrationAssociationIdentifier: associationId,
 *   ExecutionConfiguration: {
 *     ExecutionMode: "ON_DEMAND",
 *     OnDemandConfiguration: { StartTime: startEpochMillis },
 *   },
 * });
 * ```
 *
 * @binding
 */
export interface UpdateDataIntegrationAssociation extends Binding.Service<
  UpdateDataIntegrationAssociation,
  "AWS.AppIntegrations.UpdateDataIntegrationAssociation",
  <R extends DataIntegration>(
    integration: R,
  ) => Effect.Effect<
    (
      request: UpdateDataIntegrationAssociationRequest,
    ) => Effect.Effect<
      appintegrations.UpdateDataIntegrationAssociationResponse,
      appintegrations.UpdateDataIntegrationAssociationError
    >
  >
> {}
export const UpdateDataIntegrationAssociation = Binding.Service<UpdateDataIntegrationAssociation>(
  "AWS.AppIntegrations.UpdateDataIntegrationAssociation",
);

/**
 * HTTP implementation of {@link UpdateDataIntegrationAssociation}. At deploy
 * time it grants `app-integrations:UpdateDataIntegrationAssociation` on the
 * data integration (and its `data-integration-association/*` children); at
 * runtime it calls the AppIntegrations API with the host Function's
 * credentials, injecting the data integration's id. Provide this layer on
 * the Function using the binding.
 */
export const UpdateDataIntegrationAssociationHttp = Layer.effect(
  UpdateDataIntegrationAssociation,
  makeAppIntegrationsHttpBinding({
    name: "UpdateDataIntegrationAssociation",
    operation: appintegrations.updateDataIntegrationAssociation,
    requestKey: "DataIntegrationIdentifier",
    identifier: (integration: DataIntegration) => integration.dataIntegrationId,
    iamActions: ["app-integrations:UpdateDataIntegrationAssociation"],
    resources: (integration, { region, accountId }) => [
      Output.interpolate`${integration.dataIntegrationArn}`,
      Output.interpolate`arn:aws:app-integrations:${region}:${accountId}:data-integration-association/${integration.dataIntegrationId}/*`,
    ],
    // Rerunning the on-demand job snapshots through Customer Profiles on the
    // caller's behalf.
    dependentActions: ["profile:CreateSnapshot", "profile:GetSnapshot"],
  }),
);
