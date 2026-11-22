import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface CancelPhoneNumberOperationRequest extends Omit<
  phoneNumbers.CancelPhoneNumberOperationRequest,
  "endpoint"
> {}

/**
 * Cancel a phone number operation.
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
 * Provide {@link CancelPhoneNumberOperationHttp}.
 *
 * ### Calling CancelPhoneNumberOperation
 * **Example:** CancelPhoneNumberOperation from a Function
 * ```typescript
 * // init
 * const cancelPhoneNumberOperation = yield* Azure.Communication.CancelPhoneNumberOperation(acs);
 *
 * // runtime
 * yield* cancelPhoneNumberOperation({ operationId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface CancelPhoneNumberOperation extends Binding.Service<
  CancelPhoneNumberOperation,
  "Azure.Communication.CancelPhoneNumberOperation",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: CancelPhoneNumberOperationRequest,
    ) => Effect.Effect<
      phoneNumbers.CancelPhoneNumberOperationResponse,
      phoneNumbers.CancelPhoneNumberOperationError,
      RuntimeContext
    >
  >
> {}

export const CancelPhoneNumberOperation = Binding.Service<CancelPhoneNumberOperation>(
  "Azure.Communication.CancelPhoneNumberOperation",
);
