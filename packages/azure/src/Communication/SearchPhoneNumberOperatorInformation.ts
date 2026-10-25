import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface SearchPhoneNumberOperatorInformationRequest extends Omit<
  phoneNumbers.SearchPhoneNumbersOperatorInformationRequest,
  "endpoint"
> {}

/**
 * Look up the number format and operator of phone numbers.
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
 * Provide {@link SearchPhoneNumberOperatorInformationHttp}.
 *
 * ### Calling SearchPhoneNumberOperatorInformation
 * **Example:** SearchPhoneNumberOperatorInformation from a Function
 * ```typescript
 * // init
 * const searchPhoneNumberOperatorInformation = yield* Azure.Communication.SearchPhoneNumberOperatorInformation(acs);
 *
 * // runtime
 * const info = yield* searchPhoneNumberOperatorInformation({ phoneNumbers: ["+14255550123"] });
 * // info.values
 * ```
 *
 * @binding
 * @category Communication
 */
export interface SearchPhoneNumberOperatorInformation extends Binding.Service<
  SearchPhoneNumberOperatorInformation,
  "Azure.Communication.SearchPhoneNumberOperatorInformation",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: SearchPhoneNumberOperatorInformationRequest,
    ) => Effect.Effect<
      phoneNumbers.OperatorInformationResult,
      phoneNumbers.SearchPhoneNumbersOperatorInformationError,
      RuntimeContext
    >
  >
> {}

export const SearchPhoneNumberOperatorInformation =
  Binding.Service<SearchPhoneNumberOperatorInformation>(
    "Azure.Communication.SearchPhoneNumberOperatorInformation",
  );
