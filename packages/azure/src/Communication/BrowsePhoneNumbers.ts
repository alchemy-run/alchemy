import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface BrowsePhoneNumbersRequest extends Omit<
  phoneNumbers.PhoneNumbersBrowseAvailableNumbersRequest,
  "endpoint"
> {}

/**
 * Browse a random sample of phone numbers available to purchase.
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
 * Provide {@link BrowsePhoneNumbersHttp}.
 *
 * ### Calling BrowsePhoneNumbers
 * **Example:** BrowsePhoneNumbers from a Function
 * ```typescript
 * // init
 * const browsePhoneNumbers = yield* Azure.Communication.BrowsePhoneNumbers(acs);
 *
 * // runtime
 * const found = yield* browsePhoneNumbers({ countryCode: "US", phoneNumberType: "tollFree" });
 * // found.phoneNumbers
 * ```
 *
 * @binding
 * @category Communication
 */
export interface BrowsePhoneNumbers extends Binding.Service<
  BrowsePhoneNumbers,
  "Azure.Communication.BrowsePhoneNumbers",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: BrowsePhoneNumbersRequest,
    ) => Effect.Effect<
      phoneNumbers.PhoneNumbersBrowseResult,
      phoneNumbers.PhoneNumbersBrowseAvailableNumbersError,
      RuntimeContext
    >
  >
> {}

export const BrowsePhoneNumbers = Binding.Service<BrowsePhoneNumbers>(
  "Azure.Communication.BrowsePhoneNumbers",
);
