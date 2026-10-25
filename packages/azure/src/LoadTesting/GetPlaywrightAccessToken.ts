import type * as playwright from "@distilled.cloud/azure/loadtesting-playwright";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { PlaywrightWorkspace } from "./PlaywrightWorkspace.ts";

export interface GetPlaywrightAccessTokenRequest extends Omit<
  playwright.GetAccessTokenRequest,
  "endpoint" | "workspaceId"
> {}

/**
 * Read an Azure Playwright workspace access token of the host's identity
 * (without its JWT) from any host.
 *
 * Binding assigns a custom role (`AzureLoadTestingPlaywrightReadRole`, one
 * per stack) with exactly the action
 * `Microsoft.LoadTestService/playwrightWorkspaces/Read`, on the workspace
 * only (the Playwright data plane checks control-plane actions). The smallest
 * built-in role, **Playwright Workspace Reader**, also grants every other
 * workspace read. The workspace must allow local auth (`localAuth:
 * "Enabled"`); otherwise the service answers 403
 * `AccessTokenBasedAuthNotSupported`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetPlaywrightAccessTokenHttp}.
 *
 * ### Calling GetPlaywrightAccessToken
 * **Example:** GetPlaywrightAccessToken from a Function
 * ```typescript
 * // init
 * const getPlaywrightAccessToken = yield* Azure.LoadTesting.GetPlaywrightAccessToken(workspace);
 *
 * // runtime
 * const token = yield* getPlaywrightAccessToken({ accessTokenId });
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface GetPlaywrightAccessToken extends Binding.Service<
  GetPlaywrightAccessToken,
  "Azure.LoadTesting.GetPlaywrightAccessToken",
  (
    workspace: PlaywrightWorkspace,
  ) => Effect.Effect<
    (
      request: GetPlaywrightAccessTokenRequest,
    ) => Effect.Effect<playwright.AccessToken, playwright.GetAccessTokenError, RuntimeContext>
  >
> {}

export const GetPlaywrightAccessToken = Binding.Service<GetPlaywrightAccessToken>(
  "Azure.LoadTesting.GetPlaywrightAccessToken",
);
