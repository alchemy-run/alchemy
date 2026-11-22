import type * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { LoadTest } from "./LoadTest.ts";

export interface DeleteTestRunRequest extends Omit<
  loadtesting.DeleteLoadTestRunTestRunRequest,
  "endpoint"
> {}

/**
 * Delete an Azure Load Testing test run and its results from any host.
 *
 * Binding assigns a custom role (`AzureLoadTestingDeleteTestRole`, one per
 * stack) with exactly the data action
 * `Microsoft.LoadTestService/loadtests/deleteTest/action`, on the load test
 * resource only. The smallest built-in role, **Load Test Owner**, also grants
 * `Microsoft.LoadTestService/*\/read` on the resource.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteTestRunHttp}.
 *
 * ### Calling DeleteTestRun
 * **Example:** DeleteTestRun from a Function
 * ```typescript
 * // init
 * const deleteTestRun = yield* Azure.LoadTesting.DeleteTestRun(loadTest);
 *
 * // runtime
 * yield* deleteTestRun({ testRunId: "checkout-run-1" });
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface DeleteTestRun extends Binding.Service<
  DeleteTestRun,
  "Azure.LoadTesting.DeleteTestRun",
  (
    loadTest: LoadTest,
  ) => Effect.Effect<
    (
      request: DeleteTestRunRequest,
    ) => Effect.Effect<
      loadtesting.DeleteLoadTestRunTestRunResponse,
      loadtesting.DeleteLoadTestRunTestRunError,
      RuntimeContext
    >
  >
> {}

export const DeleteTestRun = Binding.Service<DeleteTestRun>("Azure.LoadTesting.DeleteTestRun");
