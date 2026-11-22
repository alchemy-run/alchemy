import type * as playwright from "@distilled.cloud/azure/loadtesting-playwright";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { PlaywrightWorkspace } from "./PlaywrightWorkspace.ts";

export interface ListPlaywrightAccessTokensRequest extends Omit<
  playwright.ListAccessTokensRequest,
  "endpoint" | "workspaceId"
> {}

/**
 * List the host identity's Azure Playwright workspace access tokens (one
 * page; pass `nextLink` for the next) from any host.
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
 * Provide {@link ListPlaywrightAccessTokensHttp}.
 *
 * ### Calling ListPlaywrightAccessTokens
 * **Example:** ListPlaywrightAccessTokens from a Function
 * ```typescript
 * // init
 * const listPlaywrightAccessTokens = yield* Azure.LoadTesting.ListPlaywrightAccessTokens(workspace);
 *
 * // runtime
 * const page = yield* listPlaywrightAccessTokens();
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface ListPlaywrightAccessTokens extends Binding.Service<
  ListPlaywrightAccessTokens,
  "Azure.LoadTesting.ListPlaywrightAccessTokens",
  (
    workspace: PlaywrightWorkspace,
  ) => Effect.Effect<
    (
      request?: ListPlaywrightAccessTokensRequest,
    ) => Effect.Effect<
      playwright.PagedAccessToken,
      playwright.ListAccessTokensError,
      RuntimeContext
    >
  >
> {}

export const ListPlaywrightAccessTokens = Binding.Service<ListPlaywrightAccessTokens>(
  "Azure.LoadTesting.ListPlaywrightAccessTokens",
);
