import type * as email from "@distilled.cloud/azure/communication-email";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetEmailSendResultRequest extends Omit<
  email.EmailGetSendResultRequest,
  "endpoint"
> {}

/**
 * Read the status of an email send operation started with {@link SendEmail}.
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
 * Provide {@link GetEmailSendResultHttp}.
 *
 * ### Calling GetEmailSendResult
 * **Example:** GetEmailSendResult from a Function
 * ```typescript
 * // init
 * const getEmailSendResult = yield* Azure.Communication.GetEmailSendResult(acs);
 *
 * // runtime
 * const result = yield* getEmailSendResult({ operationId: sent.id! });
 * // result.status → "Succeeded" | "Failed" | "Running" | …
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetEmailSendResult extends Binding.Service<
  GetEmailSendResult,
  "Azure.Communication.GetEmailSendResult",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetEmailSendResultRequest,
    ) => Effect.Effect<email.EmailSendResult, email.EmailGetSendResultError, RuntimeContext>
  >
> {}

export const GetEmailSendResult = Binding.Service<GetEmailSendResult>(
  "Azure.Communication.GetEmailSendResult",
);
