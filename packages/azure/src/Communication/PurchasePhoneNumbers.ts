import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface PurchasePhoneNumbersRequest extends Omit<
  phoneNumbers.PhoneNumbersPurchasePhoneNumbersRequest,
  "endpoint"
> {}

/**
 * Purchase the phone numbers of a search. Purchased numbers are billed
 * monthly.
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
 * Provide {@link PurchasePhoneNumbersHttp}.
 *
 * ### Calling PurchasePhoneNumbers
 * **Example:** PurchasePhoneNumbers from a Function
 * ```typescript
 * // init
 * const purchasePhoneNumbers = yield* Azure.Communication.PurchasePhoneNumbers(acs);
 *
 * // runtime
 * const purchase = yield* purchasePhoneNumbers({ searchId, agreeToNotResell: true });
 * // purchase.operationLocation
 * ```
 *
 * @binding
 * @category Communication
 */
export interface PurchasePhoneNumbers extends Binding.Service<
  PurchasePhoneNumbers,
  "Azure.Communication.PurchasePhoneNumbers",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request?: PurchasePhoneNumbersRequest,
    ) => Effect.Effect<
      phoneNumbers.PhoneNumbersPurchasePhoneNumbersResponse,
      phoneNumbers.PhoneNumbersPurchasePhoneNumbersError,
      RuntimeContext
    >
  >
> {}

export const PurchasePhoneNumbers = Binding.Service<PurchasePhoneNumbers>(
  "Azure.Communication.PurchasePhoneNumbers",
);
