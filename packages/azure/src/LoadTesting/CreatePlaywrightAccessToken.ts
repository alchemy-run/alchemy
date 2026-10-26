import type * as playwright from "@distilled.cloud/azure/loadtesting-playwright";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { PlaywrightWorkspace } from "./PlaywrightWorkspace.ts";

export interface CreatePlaywrightAccessTokenRequest extends Omit<
  playwright.AccessTokensCreateOrReplaceRequest,
  "endpoint" | "workspaceId"
> {}

/**
 * Create (or replace) an Azure Playwright workspace access token for the
 * host's identity from any host. The response carries the token's JWT once.
 *
 * The `jwtToken` comes back `Redacted`; read it with `Redacted.value`
 * where you use it.
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
 * Provide {@link CreatePlaywrightAccessTokenHttp}.
 *
 * ### Calling CreatePlaywrightAccessToken
 * **Example:** CreatePlaywrightAccessToken from a Function
 * ```typescript
 * // init
 * const createPlaywrightAccessToken = yield* Azure.LoadTesting.CreatePlaywrightAccessToken(workspace);
 *
 * // runtime
 * const token = yield* createPlaywrightAccessToken({
 *   accessTokenId: crypto.randomUUID(),
 *   name: "ci",
 *   expiryAt: new Date(Date.now() + 86_400_000).toISOString(),
 * });
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface CreatePlaywrightAccessToken extends Binding.Service<
  CreatePlaywrightAccessToken,
  "Azure.LoadTesting.CreatePlaywrightAccessToken",
  (
    workspace: PlaywrightWorkspace,
  ) => Effect.Effect<
    (
      request: CreatePlaywrightAccessTokenRequest,
    ) => Effect.Effect<
      playwright.AccessToken,
      playwright.AccessTokensCreateOrReplaceError,
      RuntimeContext
    >
  >
> {}

export const CreatePlaywrightAccessToken = Binding.Service<CreatePlaywrightAccessToken>(
  "Azure.LoadTesting.CreatePlaywrightAccessToken",
);
