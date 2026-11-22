import type * as identity from "@distilled.cloud/azure/communication-identity";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface CreateIdentityRequest extends Omit<
  identity.CreateIdentityOperationRequest,
  "endpoint"
> {}

/**
 * Create a Communication Services user identity, and optionally a user
 * access token for it (for Chat, Calling, or Rooms).
 *
 * The `accessToken.token` comes back `Redacted`; read it with
 * `Redacted.value` where you use it.
 *
 * Binding assigns a custom role (`AzureCommunicationIdentityRole`, one per
 * stack) with exactly the action
 * `Microsoft.Communication/CommunicationServices/Write`, on the communication
 * service only. The Communication Services data plane has no data actions.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CreateIdentityHttp}.
 *
 * ### Calling CreateIdentity
 * **Example:** CreateIdentity from a Function
 * ```typescript
 * // init
 * const createIdentity = yield* Azure.Communication.CreateIdentity(acs);
 *
 * // runtime
 * const created = yield* createIdentity({ createTokenWithScopes: ["chat"] });
 * // created.identity.id, created.accessToken?.token (Redacted)
 * ```
 *
 * @binding
 * @category Communication
 */
export interface CreateIdentity extends Binding.Service<
  CreateIdentity,
  "Azure.Communication.CreateIdentity",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request?: CreateIdentityRequest,
    ) => Effect.Effect<
      identity.CommunicationIdentityAccessTokenResult,
      identity.CreateIdentityOperationError,
      RuntimeContext
    >
  >
> {}

export const CreateIdentity = Binding.Service<CreateIdentity>("Azure.Communication.CreateIdentity");
