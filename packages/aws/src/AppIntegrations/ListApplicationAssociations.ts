import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Application } from "./Application.ts";
import { makeAppIntegrationsHttpBinding } from "./BindingHttp.ts";

export interface ListApplicationAssociationsRequest extends Omit<
  appintegrations.ListApplicationAssociationsRequest,
  "ApplicationId"
> {}

/**
 * Lists the associations of an AppIntegrations {@link Application} — the
 * Amazon Connect instances (or other clients) the application has been
 * associated with (`app-integrations:ListApplicationAssociations`).
 *
 * Provide the `ListApplicationAssociationsHttp` layer on the Function to
 * satisfy the binding.
 * ### Listing Application Associations
 * **Example:** List an Application's Associations
 * ```typescript
 * // init (provide AWS.AppIntegrations.ListApplicationAssociationsHttp on the Function)
 * const listApplicationAssociations =
 *   yield* AWS.AppIntegrations.ListApplicationAssociations(application);
 *
 * // runtime — the ApplicationId is injected automatically
 * const { ApplicationAssociations } = yield* listApplicationAssociations();
 * ```
 *
 * @binding
 */
export interface ListApplicationAssociations extends Binding.Service<
  ListApplicationAssociations,
  "AWS.AppIntegrations.ListApplicationAssociations",
  <R extends Application>(
    application: R,
  ) => Effect.Effect<
    (
      request?: ListApplicationAssociationsRequest,
    ) => Effect.Effect<
      appintegrations.ListApplicationAssociationsResponse,
      appintegrations.ListApplicationAssociationsError
    >
  >
> {}
export const ListApplicationAssociations = Binding.Service<ListApplicationAssociations>(
  "AWS.AppIntegrations.ListApplicationAssociations",
);

/**
 * HTTP implementation of {@link ListApplicationAssociations}. At deploy time
 * it grants `app-integrations:ListApplicationAssociations` on the application
 * (and its `application-association/*` children); at runtime it calls the
 * AppIntegrations API with the host Function's credentials, injecting the
 * application's id. Provide this layer on the Function using the binding.
 */
export const ListApplicationAssociationsHttp = Layer.effect(
  ListApplicationAssociations,
  makeAppIntegrationsHttpBinding({
    name: "ListApplicationAssociations",
    operation: appintegrations.listApplicationAssociations,
    requestKey: "ApplicationId",
    identifier: (application: Application) => application.applicationId,
    iamActions: ["app-integrations:ListApplicationAssociations"],
    resources: (application, { region, accountId }) => [
      Output.interpolate`${application.applicationArn}`,
      Output.interpolate`arn:aws:app-integrations:${region}:${accountId}:application-association/${application.applicationId}/*`,
    ],
  }),
);
