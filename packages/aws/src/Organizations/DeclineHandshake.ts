import * as organizations from "@distilled.cloud/aws/organizations";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `organizations:DeclineHandshake`.
 *
 * Declines a pending handshake, ending the invitation from the recipient side; the originator can no longer act on it.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.DeclineHandshakeHttp)`.
 * ### Handshakes & Invitations
 * **Example:** Decline an Invitation
 * ```typescript
 * // init — account-level binding, no resource argument
 * const declineHandshake = yield* AWS.Organizations.DeclineHandshake();
 *
 * // runtime
 * const { Handshake } = yield* declineHandshake({ HandshakeId: handshakeId });
 * ```
 *
 * @binding
 */
export interface DeclineHandshake extends Binding.Service<
  DeclineHandshake,
  "AWS.Organizations.DeclineHandshake",
  () => Effect.Effect<
    (
      request: organizations.DeclineHandshakeRequest,
    ) => Effect.Effect<organizations.DeclineHandshakeResponse, organizations.DeclineHandshakeError>
  >
> {}
export const DeclineHandshake = Binding.Service<DeclineHandshake>(
  "AWS.Organizations.DeclineHandshake",
);

export const DeclineHandshakeHttp = Layer.effect(
  DeclineHandshake,
  makeOrganizationsHttpBinding({
    capability: "DeclineHandshake",
    iamActions: ["organizations:DeclineHandshake"],
    operation: organizations.declineHandshake,
  }),
);
