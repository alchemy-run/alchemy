import type * as playwright from "@distilled.cloud/azure/loadtesting-playwright";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { PlaywrightWorkspace } from "./PlaywrightWorkspace.ts";

export interface DeletePlaywrightAccessTokenRequest extends Omit<
  playwright.DeleteAccessTokenRequest,
  "endpoint" | "workspaceId"
> {}

/**
 * Delete an Azure Playwright workspace access token of the host's identity
 * from any host.
 *
 * Binding assigns a custom role
 * (`AzureLoadTestingPlaywrightAccessTokensRole`, one per stack) with exactly
 * the action
 * `Microsoft.LoadTestService/playwrightWorkspaces/AccessTokens/Write`, on the
 * workspace only (the Playwright data plane checks control-plane actions).
 * The smallest built-in role, **Playwright Workspace Contributor**, also
 * grants every other workspace read. The workspace must allow local auth
 * (`localAuth: "Enabled"`); otherwise the service answers 403
 * `AccessTokenBasedAuthNotSupported`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeletePlaywrightAccessTokenHttp}.
 *
 * ### Calling DeletePlaywrightAccessToken
 * **Example:** DeletePlaywrightAccessToken from a Function
 * ```typescript
 * // init
 * const deletePlaywrightAccessToken = yield* Azure.LoadTesting.DeletePlaywrightAccessToken(workspace);
 *
 * // runtime
 * yield* deletePlaywrightAccessToken({ accessTokenId });
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface DeletePlaywrightAccessToken extends Binding.Service<
  DeletePlaywrightAccessToken,
  "Azure.LoadTesting.DeletePlaywrightAccessToken",
  (
    workspace: PlaywrightWorkspace,
  ) => Effect.Effect<
    (
      request: DeletePlaywrightAccessTokenRequest,
    ) => Effect.Effect<
      playwright.DeleteAccessTokenResponse,
      playwright.DeleteAccessTokenError,
      RuntimeContext
    >
  >
> {}

export const DeletePlaywrightAccessToken = Binding.Service<DeletePlaywrightAccessToken>(
  "Azure.LoadTesting.DeletePlaywrightAccessToken",
);
