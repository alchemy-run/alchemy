import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAppIntegrationsHttpBinding } from "./BindingHttp.ts";
import type { EventIntegration } from "./EventIntegration.ts";

export interface ListEventIntegrationAssociationsRequest extends Omit<
  appintegrations.ListEventIntegrationAssociationsRequest,
  "EventIntegrationName"
> {}

/**
 * Lists the associations of an AppIntegrations {@link EventIntegration} —
 * the clients that have associated with the event integration
 * (`app-integrations:ListEventIntegrationAssociations`).
 *
 * Provide the `ListEventIntegrationAssociationsHttp` layer on the Function
 * to satisfy the binding.
 * ### Listing Event Integration Associations
 * **Example:** List an Event Integration's Associations
 * ```typescript
 * // init (provide AWS.AppIntegrations.ListEventIntegrationAssociationsHttp on the Function)
 * const listEventIntegrationAssociations =
 *   yield* AWS.AppIntegrations.ListEventIntegrationAssociations(integration);
 *
 * // runtime — the EventIntegrationName is injected automatically
 * const { EventIntegrationAssociations } =
 *   yield* listEventIntegrationAssociations();
 * ```
 *
 * @binding
 */
export interface ListEventIntegrationAssociations extends Binding.Service<
  ListEventIntegrationAssociations,
  "AWS.AppIntegrations.ListEventIntegrationAssociations",
  <R extends EventIntegration>(
    integration: R,
  ) => Effect.Effect<
    (
      request?: ListEventIntegrationAssociationsRequest,
    ) => Effect.Effect<
      appintegrations.ListEventIntegrationAssociationsResponse,
      appintegrations.ListEventIntegrationAssociationsError
    >
  >
> {}
export const ListEventIntegrationAssociations = Binding.Service<ListEventIntegrationAssociations>(
  "AWS.AppIntegrations.ListEventIntegrationAssociations",
);

/**
 * HTTP implementation of {@link ListEventIntegrationAssociations}. At deploy
 * time it grants `app-integrations:ListEventIntegrationAssociations` on the
 * event integration (and its `event-integration-association/*` children); at
 * runtime it calls the AppIntegrations API with the host Function's
 * credentials, injecting the event integration's name. Provide this layer on
 * the Function using the binding.
 */
export const ListEventIntegrationAssociationsHttp = Layer.effect(
  ListEventIntegrationAssociations,
  makeAppIntegrationsHttpBinding({
    name: "ListEventIntegrationAssociations",
    operation: appintegrations.listEventIntegrationAssociations,
    requestKey: "EventIntegrationName",
    identifier: (integration: EventIntegration) => integration.eventIntegrationName,
    iamActions: ["app-integrations:ListEventIntegrationAssociations"],
    resources: (integration, { region, accountId }) => [
      Output.interpolate`${integration.eventIntegrationArn}`,
      Output.interpolate`arn:aws:app-integrations:${region}:${accountId}:event-integration-association/${integration.eventIntegrationName}/*`,
    ],
  }),
);
