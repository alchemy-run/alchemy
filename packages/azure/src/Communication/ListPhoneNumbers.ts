import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ListPhoneNumbersRequest extends Omit<
  phoneNumbers.ListPhoneNumberPhoneNumbersRequest,
  "endpoint"
> {}

/**
 * List the phone numbers the communication service owns, one page per call
 * (pass the previous page's `nextLink` for the next).
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
 * Provide {@link ListPhoneNumbersHttp}.
 *
 * ### Calling ListPhoneNumbers
 * **Example:** ListPhoneNumbers from a Function
 * ```typescript
 * // init
 * const listPhoneNumbers = yield* Azure.Communication.ListPhoneNumbers(acs);
 *
 * // runtime
 * const page = yield* listPhoneNumbers();
 * // page.phoneNumbers
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ListPhoneNumbers extends Binding.Service<
  ListPhoneNumbers,
  "Azure.Communication.ListPhoneNumbers",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request?: ListPhoneNumbersRequest,
    ) => Effect.Effect<
      phoneNumbers.PurchasedPhoneNumbers,
      phoneNumbers.ListPhoneNumberPhoneNumbersError,
      RuntimeContext
    >
  >
> {}

export const ListPhoneNumbers = Binding.Service<ListPhoneNumbers>(
  "Azure.Communication.ListPhoneNumbers",
);
