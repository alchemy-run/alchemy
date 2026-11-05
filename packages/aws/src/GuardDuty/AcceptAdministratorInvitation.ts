import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeGuardDutyDetectorHttpBinding } from "./BindingHttp.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:AcceptAdministratorInvitation`.
 *
 * Accepts a GuardDuty administrator invitation — the member-account side of the invitation handshake.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.AcceptAdministratorInvitationHttp)`.
 * ### Administrator & Invitations
 * **Example:** Accept an Invitation
 * ```typescript
 * // init
 * const acceptAdministratorInvitation = yield* AWS.GuardDuty.AcceptAdministratorInvitation(detector);
 *
 * // runtime
 * yield* acceptAdministratorInvitation({
 *   AdministratorId: adminAccountId,
 *   InvitationId: invitationId,
 * });
 * ```
 *
 * @binding
 */
export interface AcceptAdministratorInvitation extends Binding.Service<
  AcceptAdministratorInvitation,
  "AWS.GuardDuty.AcceptAdministratorInvitation",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.AcceptAdministratorInvitationRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.AcceptAdministratorInvitationResponse,
      guardduty.AcceptAdministratorInvitationError
    >
  >
> {}
export const AcceptAdministratorInvitation = Binding.Service<AcceptAdministratorInvitation>(
  "AWS.GuardDuty.AcceptAdministratorInvitation",
);

export const AcceptAdministratorInvitationHttp = Layer.effect(
  AcceptAdministratorInvitation,
  makeGuardDutyDetectorHttpBinding({
    tag: "AWS.GuardDuty.AcceptAdministratorInvitation",
    operation: guardduty.acceptAdministratorInvitation,
    actions: ["guardduty:AcceptAdministratorInvitation"],
  }),
);
