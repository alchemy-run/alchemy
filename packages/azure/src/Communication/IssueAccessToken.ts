import type * as identity from "@distilled.cloud/azure/communication-identity";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface IssueAccessTokenRequest extends Omit<
  identity.IdentityOperationsIssueAccessTokenRequest,
  "endpoint"
> {}

/**
 * Issue a user access token for an existing Communication Services identity.
 *
 * Binding assigns a custom role (`AzureCommunicationIdentityRole`, one per
 * stack) with exactly the action
 * `Microsoft.Communication/CommunicationServices/Write`, on the communication
 * service only. The Communication Services data plane has no data actions.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link IssueAccessTokenHttp}.
 *
 * ### Calling IssueAccessToken
 * **Example:** IssueAccessToken from a Function
 * ```typescript
 * // init
 * const issueAccessToken = yield* Azure.Communication.IssueAccessToken(acs);
 *
 * // runtime
 * const token = yield* issueAccessToken({ id: userId, scopes: ["chat"], expiresInMinutes: 60 });
 * // token.token, token.expiresOn
 * ```
 *
 * @binding
 * @category Communication
 */
export interface IssueAccessToken extends Binding.Service<
  IssueAccessToken,
  "Azure.Communication.IssueAccessToken",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: IssueAccessTokenRequest,
    ) => Effect.Effect<
      identity.CommunicationIdentityAccessToken,
      identity.IdentityOperationsIssueAccessTokenError,
      RuntimeContext
    >
  >
> {}

export const IssueAccessToken = Binding.Service<IssueAccessToken>(
  "Azure.Communication.IssueAccessToken",
);
