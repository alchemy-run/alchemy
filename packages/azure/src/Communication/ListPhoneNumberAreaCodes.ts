import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ListPhoneNumberAreaCodesRequest extends Omit<
  phoneNumbers.ListPhoneNumberAreaCodesRequest,
  "endpoint"
> {}

/**
 * List the area codes with available numbers in a country.
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
 * Provide {@link ListPhoneNumberAreaCodesHttp}.
 *
 * ### Calling ListPhoneNumberAreaCodes
 * **Example:** ListPhoneNumberAreaCodes from a Function
 * ```typescript
 * // init
 * const listPhoneNumberAreaCodes = yield* Azure.Communication.ListPhoneNumberAreaCodes(acs);
 *
 * // runtime
 * const page = yield* listPhoneNumberAreaCodes({
 *   countryCode: "US",
 *   phoneNumberType: "tollFree",
 *   assignmentType: "application",
 * });
 * // page.areaCodes
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ListPhoneNumberAreaCodes extends Binding.Service<
  ListPhoneNumberAreaCodes,
  "Azure.Communication.ListPhoneNumberAreaCodes",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: ListPhoneNumberAreaCodesRequest,
    ) => Effect.Effect<
      phoneNumbers.PhoneNumberAreaCodes,
      phoneNumbers.ListPhoneNumberAreaCodesError,
      RuntimeContext
    >
  >
> {}

export const ListPhoneNumberAreaCodes = Binding.Service<ListPhoneNumberAreaCodes>(
  "Azure.Communication.ListPhoneNumberAreaCodes",
);
