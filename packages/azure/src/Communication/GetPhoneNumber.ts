import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetPhoneNumberRequest extends Omit<
  phoneNumbers.GetPhoneNumberByNumberRequest,
  "endpoint"
> {}

/**
 * Read a phone number the communication service owns.
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
 * Provide {@link GetPhoneNumberHttp}.
 *
 * ### Calling GetPhoneNumber
 * **Example:** GetPhoneNumber from a Function
 * ```typescript
 * // init
 * const getPhoneNumber = yield* Azure.Communication.GetPhoneNumber(acs);
 *
 * // runtime
 * const number = yield* getPhoneNumber({ phoneNumber: "+18005550100" });
 * // number.capabilities
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetPhoneNumber extends Binding.Service<
  GetPhoneNumber,
  "Azure.Communication.GetPhoneNumber",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetPhoneNumberRequest,
    ) => Effect.Effect<
      phoneNumbers.PurchasedPhoneNumber,
      phoneNumbers.GetPhoneNumberByNumberError,
      RuntimeContext
    >
  >
> {}

export const GetPhoneNumber = Binding.Service<GetPhoneNumber>("Azure.Communication.GetPhoneNumber");
