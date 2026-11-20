import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAppIntegrationsAccountHttpBinding } from "./BindingHttp.ts";

export interface ListApplicationsRequest extends appintegrations.ListApplicationsRequest {}

/**
 * Lists the AppIntegrations applications in the account
 * (`app-integrations:ListApplications`).
 *
 * An account-level operation — bind it with no resource argument. Provide the
 * `ListApplicationsHttp` layer on the Function to satisfy the binding.
 * ### Listing Applications
 * **Example:** List All Applications
 * ```typescript
 * // init — no resource argument (provide AWS.AppIntegrations.ListApplicationsHttp on the Function)
 * const listApplications = yield* AWS.AppIntegrations.ListApplications();
 *
 * // runtime — page through the applications in the account
 * const { Applications } = yield* listApplications({});
 * ```
 *
 * @binding
 */
export interface ListApplications extends Binding.Service<
  ListApplications,
  "AWS.AppIntegrations.ListApplications",
  () => Effect.Effect<
    (
      request?: ListApplicationsRequest,
    ) => Effect.Effect<
      appintegrations.ListApplicationsResponse,
      appintegrations.ListApplicationsError
    >
  >
> {}
export const ListApplications = Binding.Service<ListApplications>(
  "AWS.AppIntegrations.ListApplications",
);

/**
 * HTTP implementation of {@link ListApplications}. At deploy time it grants
 * `app-integrations:ListApplications`; at runtime it calls the
 * AppIntegrations API with the host Function's credentials. Provide this
 * layer on the Function using the binding.
 */
export const ListApplicationsHttp = Layer.effect(
  ListApplications,
  makeAppIntegrationsAccountHttpBinding({
    name: "ListApplications",
    operation: appintegrations.listApplications,
    iamActions: ["app-integrations:ListApplications"],
  }),
);
