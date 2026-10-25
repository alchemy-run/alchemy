import type * as sms from "@distilled.cloud/azure/communication-sms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface RemoveSmsOptOutRequest extends Omit<sms.RemoveOptOutRequest, "endpoint"> {}

/**
 * Remove recipient numbers from a sender number's opt-out list.
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
 * Provide {@link RemoveSmsOptOutHttp}.
 *
 * ### Calling RemoveSmsOptOut
 * **Example:** RemoveSmsOptOut from a Function
 * ```typescript
 * // init
 * const removeSmsOptOut = yield* Azure.Communication.RemoveSmsOptOut(acs);
 *
 * // runtime
 * const removed = yield* removeSmsOptOut({ from: "+18005550100", recipients: [{ to: "+14255550123" }] });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface RemoveSmsOptOut extends Binding.Service<
  RemoveSmsOptOut,
  "Azure.Communication.RemoveSmsOptOut",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: RemoveSmsOptOutRequest,
    ) => Effect.Effect<sms.OptOutResponse, sms.RemoveOptOutError, RuntimeContext>
  >
> {}

export const RemoveSmsOptOut = Binding.Service<RemoveSmsOptOut>(
  "Azure.Communication.RemoveSmsOptOut",
);
