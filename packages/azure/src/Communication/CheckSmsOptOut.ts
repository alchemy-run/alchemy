import type * as sms from "@distilled.cloud/azure/communication-sms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface CheckSmsOptOutRequest extends Omit<sms.CheckOptOutRequest, "endpoint"> {}

/**
 * Check whether recipient numbers opted out of a sender number's SMS.
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
 * Provide {@link CheckSmsOptOutHttp}.
 *
 * ### Calling CheckSmsOptOut
 * **Example:** CheckSmsOptOut from a Function
 * ```typescript
 * // init
 * const checkSmsOptOut = yield* Azure.Communication.CheckSmsOptOut(acs);
 *
 * // runtime
 * const checked = yield* checkSmsOptOut({ from: "+18005550100", recipients: [{ to: "+14255550123" }] });
 * // checked.value[0].isOptedOut
 * ```
 *
 * @binding
 * @category Communication
 */
export interface CheckSmsOptOut extends Binding.Service<
  CheckSmsOptOut,
  "Azure.Communication.CheckSmsOptOut",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: CheckSmsOptOutRequest,
    ) => Effect.Effect<sms.OptOutResponse, sms.CheckOptOutError, RuntimeContext>
  >
> {}

export const CheckSmsOptOut = Binding.Service<CheckSmsOptOut>("Azure.Communication.CheckSmsOptOut");
