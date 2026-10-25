import type * as playwright from "@distilled.cloud/azure/loadtesting-playwright";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { PlaywrightWorkspace } from "./PlaywrightWorkspace.ts";

export interface ListPlaywrightTestRunsRequest extends Omit<
  playwright.ListTestRunsRequest,
  "endpoint" | "workspaceId"
> {}

/**
 * List the test runs of an Azure Playwright workspace (one page; pass
 * `nextLink` for the next) from any host.
 *
 * Binding assigns a custom role
 * (`AzureLoadTestingPlaywrightReadTestRunsRole`, one per stack) with exactly
 * the action `Microsoft.LoadTestService/playwrightWorkspaces/TestRuns/Read`,
 * on the workspace only (the Playwright data plane checks control-plane
 * actions). The smallest built-in role, **Playwright Workspace Contributor**,
 * also grants every other workspace read. Test runs live on the workspace's
 * reporting host, `https://{region}.reporting.api.playwright.microsoft.com`;
 * the binding derives it from the workspace's `dataplaneUri`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListPlaywrightTestRunsHttp}.
 *
 * ### Calling ListPlaywrightTestRuns
 * **Example:** ListPlaywrightTestRuns from a Function
 * ```typescript
 * // init
 * const listPlaywrightTestRuns = yield* Azure.LoadTesting.ListPlaywrightTestRuns(workspace);
 *
 * // runtime
 * const page = yield* listPlaywrightTestRuns();
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface ListPlaywrightTestRuns extends Binding.Service<
  ListPlaywrightTestRuns,
  "Azure.LoadTesting.ListPlaywrightTestRuns",
  (
    workspace: PlaywrightWorkspace,
  ) => Effect.Effect<
    (
      request?: ListPlaywrightTestRunsRequest,
    ) => Effect.Effect<playwright.PagedTestRun, playwright.ListTestRunsError, RuntimeContext>
  >
> {}

export const ListPlaywrightTestRuns = Binding.Service<ListPlaywrightTestRuns>(
  "Azure.LoadTesting.ListPlaywrightTestRuns",
);
