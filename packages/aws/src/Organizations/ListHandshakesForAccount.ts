import * as organizations from "@distilled.cloud/aws/organizations";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `organizations:ListHandshakesForAccount`.
 *
 * Lists the handshakes that are associated with the calling account — pending and recently concluded invitations.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListHandshakesForAccountHttp)`.
 * ### Handshakes & Invitations
 * **Example:** List the Account's Handshakes
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listHandshakesForAccount = yield* AWS.Organizations.ListHandshakesForAccount();
 *
 * // runtime
 * const { Handshakes } = yield* listHandshakesForAccount();
 * ```
 *
 * @binding
 */
export interface ListHandshakesForAccount extends Binding.Service<
  ListHandshakesForAccount,
  "AWS.Organizations.ListHandshakesForAccount",
  () => Effect.Effect<
    (
      request?: organizations.ListHandshakesForAccountRequest,
    ) => Effect.Effect<
      organizations.ListHandshakesForAccountResponse,
      organizations.ListHandshakesForAccountError
    >
  >
> {}
export const ListHandshakesForAccount = Binding.Service<ListHandshakesForAccount>(
  "AWS.Organizations.ListHandshakesForAccount",
);

export const ListHandshakesForAccountHttp = Layer.effect(
  ListHandshakesForAccount,
  makeOrganizationsHttpBinding({
    capability: "ListHandshakesForAccount",
    iamActions: ["organizations:ListHandshakesForAccount"],
    operation: organizations.listHandshakesForAccount,
  }),
);
