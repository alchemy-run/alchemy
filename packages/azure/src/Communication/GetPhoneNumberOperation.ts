import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetPhoneNumberOperationRequest extends Omit<
  phoneNumbers.GetPhoneNumberOperationRequest,
  "endpoint"
> {}

/**
 * Read a phone number operation (search, purchase, release, or capabilities
 * update).
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
 * Provide {@link GetPhoneNumberOperationHttp}.
 *
 * ### Calling GetPhoneNumberOperation
 * **Example:** GetPhoneNumberOperation from a Function
 * ```typescript
 * // init
 * const getPhoneNumberOperation = yield* Azure.Communication.GetPhoneNumberOperation(acs);
 *
 * // runtime
 * const operation = yield* getPhoneNumberOperation({ operationId });
 * // operation.status
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetPhoneNumberOperation extends Binding.Service<
  GetPhoneNumberOperation,
  "Azure.Communication.GetPhoneNumberOperation",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetPhoneNumberOperationRequest,
    ) => Effect.Effect<
      phoneNumbers.PhoneNumberOperation,
      phoneNumbers.GetPhoneNumberOperationError,
      RuntimeContext
    >
  >
> {}

export const GetPhoneNumberOperation = Binding.Service<GetPhoneNumberOperation>(
  "Azure.Communication.GetPhoneNumberOperation",
);
