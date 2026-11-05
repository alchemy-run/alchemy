import * as organizations from "@distilled.cloud/aws/organizations";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `organizations:ListHandshakesForOrganization`.
 *
 * Lists the handshakes sent by the organization's management account — outstanding and recently concluded invitations.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListHandshakesForOrganizationHttp)`.
 * ### Handshakes & Invitations
 * **Example:** List the Organization's Handshakes
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listHandshakesForOrganization = yield* AWS.Organizations.ListHandshakesForOrganization();
 *
 * // runtime
 * const { Handshakes } = yield* listHandshakesForOrganization();
 * ```
 *
 * @binding
 */
export interface ListHandshakesForOrganization extends Binding.Service<
  ListHandshakesForOrganization,
  "AWS.Organizations.ListHandshakesForOrganization",
  () => Effect.Effect<
    (
      request?: organizations.ListHandshakesForOrganizationRequest,
    ) => Effect.Effect<
      organizations.ListHandshakesForOrganizationResponse,
      organizations.ListHandshakesForOrganizationError
    >
  >
> {}
export const ListHandshakesForOrganization = Binding.Service<ListHandshakesForOrganization>(
  "AWS.Organizations.ListHandshakesForOrganization",
);

export const ListHandshakesForOrganizationHttp = Layer.effect(
  ListHandshakesForOrganization,
  makeOrganizationsHttpBinding({
    capability: "ListHandshakesForOrganization",
    iamActions: ["organizations:ListHandshakesForOrganization"],
    operation: organizations.listHandshakesForOrganization,
  }),
);
