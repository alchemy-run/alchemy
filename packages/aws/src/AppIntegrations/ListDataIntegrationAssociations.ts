import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAppIntegrationsHttpBinding } from "./BindingHttp.ts";
import type { DataIntegration } from "./DataIntegration.ts";

export interface ListDataIntegrationAssociationsRequest extends Omit<
  appintegrations.ListDataIntegrationAssociationsRequest,
  "DataIntegrationIdentifier"
> {}

/**
 * Lists the associations of an AppIntegrations {@link DataIntegration} — the
 * clients (e.g. Amazon Connect / Amazon Q) it has been associated with
 * (`app-integrations:ListDataIntegrationAssociations`).
 *
 * Provide the `ListDataIntegrationAssociationsHttp` layer on the Function to
 * satisfy the binding.
 * ### Listing Data Integration Associations
 * **Example:** List a Data Integration's Associations
 * ```typescript
 * // init (provide AWS.AppIntegrations.ListDataIntegrationAssociationsHttp on the Function)
 * const listDataIntegrationAssociations =
 *   yield* AWS.AppIntegrations.ListDataIntegrationAssociations(integration);
 *
 * // runtime — the DataIntegrationIdentifier is injected automatically
 * const { DataIntegrationAssociations } =
 *   yield* listDataIntegrationAssociations();
 * ```
 *
 * @binding
 */
export interface ListDataIntegrationAssociations extends Binding.Service<
  ListDataIntegrationAssociations,
  "AWS.AppIntegrations.ListDataIntegrationAssociations",
  <R extends DataIntegration>(
    integration: R,
  ) => Effect.Effect<
    (
      request?: ListDataIntegrationAssociationsRequest,
    ) => Effect.Effect<
      appintegrations.ListDataIntegrationAssociationsResponse,
      appintegrations.ListDataIntegrationAssociationsError
    >
  >
> {}
export const ListDataIntegrationAssociations = Binding.Service<ListDataIntegrationAssociations>(
  "AWS.AppIntegrations.ListDataIntegrationAssociations",
);

/**
 * HTTP implementation of {@link ListDataIntegrationAssociations}. At deploy
 * time it grants `app-integrations:ListDataIntegrationAssociations` on the
 * data integration (and its `data-integration-association/*` children); at
 * runtime it calls the AppIntegrations API with the host Function's
 * credentials, injecting the data integration's id. Provide this layer on
 * the Function using the binding.
 */
export const ListDataIntegrationAssociationsHttp = Layer.effect(
  ListDataIntegrationAssociations,
  makeAppIntegrationsHttpBinding({
    name: "ListDataIntegrationAssociations",
    operation: appintegrations.listDataIntegrationAssociations,
    requestKey: "DataIntegrationIdentifier",
    identifier: (integration: DataIntegration) => integration.dataIntegrationId,
    iamActions: ["app-integrations:ListDataIntegrationAssociations"],
    resources: (integration, { region, accountId }) => [
      Output.interpolate`${integration.dataIntegrationArn}`,
      Output.interpolate`arn:aws:app-integrations:${region}:${accountId}:data-integration-association/${integration.dataIntegrationId}/*`,
    ],
  }),
);
