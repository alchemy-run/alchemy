import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ReleasePhoneNumberRequest extends Omit<
  phoneNumbers.PhoneNumbersReleasePhoneNumberRequest,
  "endpoint"
> {}

/**
 * Release an owned phone number. The number stops working and billing.
 *
 * Binding assigns a custom role (`AzureCommunicationDataRole`, one per stack)
 * with exactly the actions `Microsoft.Communication/CommunicationServices/Read`
 * and `/Write`, on the communication service only. The Communication
 * Services data plane has no data actions and denies Entra callers without
 * both, reads included.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ReleasePhoneNumberHttp}.
 *
 * ### Calling ReleasePhoneNumber
 * **Example:** ReleasePhoneNumber from a Function
 * ```typescript
 * // init
 * const releasePhoneNumber = yield* Azure.Communication.ReleasePhoneNumber(acs);
 *
 * // runtime
 * yield* releasePhoneNumber({ phoneNumber: "+18005550100" });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ReleasePhoneNumber extends Binding.Service<
  ReleasePhoneNumber,
  "Azure.Communication.ReleasePhoneNumber",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: ReleasePhoneNumberRequest,
    ) => Effect.Effect<
      phoneNumbers.PhoneNumbersReleasePhoneNumberResponse,
      phoneNumbers.PhoneNumbersReleasePhoneNumberError,
      RuntimeContext
    >
  >
> {}

export const ReleasePhoneNumber = Binding.Service<ReleasePhoneNumber>(
  "Azure.Communication.ReleasePhoneNumber",
);
