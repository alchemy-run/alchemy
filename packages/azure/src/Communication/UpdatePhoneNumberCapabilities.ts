import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface UpdatePhoneNumberCapabilitiesRequest extends Omit<
  phoneNumbers.UpdatePhoneNumberCapabilitiesRequest,
  "endpoint"
> {}

/**
 * Change the calling and SMS capabilities of an owned phone number.
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
 * Provide {@link UpdatePhoneNumberCapabilitiesHttp}.
 *
 * ### Calling UpdatePhoneNumberCapabilities
 * **Example:** UpdatePhoneNumberCapabilities from a Function
 * ```typescript
 * // init
 * const updatePhoneNumberCapabilities = yield* Azure.Communication.UpdatePhoneNumberCapabilities(acs);
 *
 * // runtime
 * yield* updatePhoneNumberCapabilities({
 *   phoneNumber: "+18005550100",
 *   calling: "inbound+outbound",
 *   sms: "none",
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface UpdatePhoneNumberCapabilities extends Binding.Service<
  UpdatePhoneNumberCapabilities,
  "Azure.Communication.UpdatePhoneNumberCapabilities",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: UpdatePhoneNumberCapabilitiesRequest,
    ) => Effect.Effect<
      phoneNumbers.UpdatePhoneNumberCapabilitiesResponse,
      phoneNumbers.UpdatePhoneNumberCapabilitiesError,
      RuntimeContext
    >
  >
> {}

export const UpdatePhoneNumberCapabilities = Binding.Service<UpdatePhoneNumberCapabilities>(
  "Azure.Communication.UpdatePhoneNumberCapabilities",
);
