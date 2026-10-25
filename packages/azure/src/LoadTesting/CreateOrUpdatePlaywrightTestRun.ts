import type * as playwright from "@distilled.cloud/azure/loadtesting-playwright";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { PlaywrightWorkspace } from "./PlaywrightWorkspace.ts";

export interface CreateOrUpdatePlaywrightTestRunRequest extends Omit<
  playwright.TestRunsCreateOrUpdateRequest,
  "endpoint" | "workspaceId"
> {}

/**
 * Create or update an Azure Playwright workspace test run (the record the
 * Playwright reporter tracks) from any host.
 *
 * Binding assigns a custom role
 * (`AzureLoadTestingPlaywrightWriteTestRunsRole`, one per stack) with exactly
 * the action `Microsoft.LoadTestService/playwrightWorkspaces/TestRuns/Write`,
 * on the workspace only (the Playwright data plane checks control-plane
 * actions). The smallest built-in role, **Playwright Workspace Contributor**,
 * also grants every other workspace read. Test runs live on the workspace's
 * reporting host, `https://{region}.reporting.api.playwright.microsoft.com`;
 * the binding derives it from the workspace's `dataplaneUri`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CreateOrUpdatePlaywrightTestRunHttp}.
 *
 * ### Calling CreateOrUpdatePlaywrightTestRun
 * **Example:** CreateOrUpdatePlaywrightTestRun from a Function
 * ```typescript
 * // init
 * const createOrUpdatePlaywrightTestRun = yield* Azure.LoadTesting.CreateOrUpdatePlaywrightTestRun(workspace);
 *
 * // runtime
 * const run = yield* createOrUpdatePlaywrightTestRun({
 *   runId: crypto.randomUUID(),
 *   displayName: "nightly",
 * });
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface CreateOrUpdatePlaywrightTestRun extends Binding.Service<
  CreateOrUpdatePlaywrightTestRun,
  "Azure.LoadTesting.CreateOrUpdatePlaywrightTestRun",
  (
    workspace: PlaywrightWorkspace,
  ) => Effect.Effect<
    (
      request: CreateOrUpdatePlaywrightTestRunRequest,
    ) => Effect.Effect<playwright.TestRun, playwright.TestRunsCreateOrUpdateError, RuntimeContext>
  >
> {}

export const CreateOrUpdatePlaywrightTestRun = Binding.Service<CreateOrUpdatePlaywrightTestRun>(
  "Azure.LoadTesting.CreateOrUpdatePlaywrightTestRun",
);
