import type * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ConnectCallRequest extends Omit<callAutomation.ConnectRequest, "endpoint"> {}

/**
 * Connect to an existing call (a room, a server call, or a group call) by
 * its call locator.
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
 * Provide {@link ConnectCallHttp}.
 *
 * ### Calling ConnectCall
 * **Example:** ConnectCall from a Function
 * ```typescript
 * // init
 * const connectCall = yield* Azure.Communication.ConnectCall(acs);
 *
 * // runtime
 * const call = yield* connectCall({
 *   callLocator: { kind: "roomCallLocator", roomId },
 *   callbackUri: "https://example.com/call-events",
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ConnectCall extends Binding.Service<
  ConnectCall,
  "Azure.Communication.ConnectCall",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: ConnectCallRequest,
    ) => Effect.Effect<
      callAutomation.CallConnectionProperties,
      callAutomation.ConnectError,
      RuntimeContext
    >
  >
> {}

export const ConnectCall = Binding.Service<ConnectCall>("Azure.Communication.ConnectCall");
