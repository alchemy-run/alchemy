import type * as sms from "@distilled.cloud/azure/communication-sms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface AddSmsOptOutRequest extends Omit<sms.AddOptOutRequest, "endpoint"> {}

/**
 * Add recipient numbers to a sender number's opt-out list, so they stop
 * receiving its SMS.
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
 * Provide {@link AddSmsOptOutHttp}.
 *
 * ### Calling AddSmsOptOut
 * **Example:** AddSmsOptOut from a Function
 * ```typescript
 * // init
 * const addSmsOptOut = yield* Azure.Communication.AddSmsOptOut(acs);
 *
 * // runtime
 * const added = yield* addSmsOptOut({ from: "+18005550100", recipients: [{ to: "+14255550123" }] });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface AddSmsOptOut extends Binding.Service<
  AddSmsOptOut,
  "Azure.Communication.AddSmsOptOut",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: AddSmsOptOutRequest,
    ) => Effect.Effect<sms.OptOutResponse, sms.AddOptOutError, RuntimeContext>
  >
> {}

export const AddSmsOptOut = Binding.Service<AddSmsOptOut>("Azure.Communication.AddSmsOptOut");
