import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAppIntegrationsAccountHttpBinding } from "./BindingHttp.ts";

export interface ListDataIntegrationsRequest extends appintegrations.ListDataIntegrationsRequest {}

/**
 * Lists the AppIntegrations data integrations in the account
 * (`app-integrations:ListDataIntegrations`).
 *
 * An account-level operation — bind it with no resource argument. Provide the
 * `ListDataIntegrationsHttp` layer on the Function to satisfy the binding.
 * ### Listing Data Integrations
 * **Example:** List All Data Integrations
 * ```typescript
 * // init — no resource argument (provide AWS.AppIntegrations.ListDataIntegrationsHttp on the Function)
 * const listDataIntegrations = yield* AWS.AppIntegrations.ListDataIntegrations();
 *
 * // runtime — page through the data integrations in the account
 * const { DataIntegrations } = yield* listDataIntegrations({});
 * ```
 *
 * @binding
 */
export interface ListDataIntegrations extends Binding.Service<
  ListDataIntegrations,
  "AWS.AppIntegrations.ListDataIntegrations",
  () => Effect.Effect<
    (
      request?: ListDataIntegrationsRequest,
    ) => Effect.Effect<
      appintegrations.ListDataIntegrationsResponse,
      appintegrations.ListDataIntegrationsError
    >
  >
> {}
export const ListDataIntegrations = Binding.Service<ListDataIntegrations>(
  "AWS.AppIntegrations.ListDataIntegrations",
);

/**
 * HTTP implementation of {@link ListDataIntegrations}. At deploy time it
 * grants `app-integrations:ListDataIntegrations`; at runtime it calls the
 * AppIntegrations API with the host Function's credentials. Provide this
 * layer on the Function using the binding.
 */
export const ListDataIntegrationsHttp = Layer.effect(
  ListDataIntegrations,
  makeAppIntegrationsAccountHttpBinding({
    name: "ListDataIntegrations",
    operation: appintegrations.listDataIntegrations,
    iamActions: ["app-integrations:ListDataIntegrations"],
  }),
);
