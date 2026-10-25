import type * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { LoadTest } from "./LoadTest.ts";

export interface GetTestRunRequest extends Omit<
  loadtesting.GetLoadTestRunTestRunRequest,
  "endpoint"
> {}

/**
 * Read an Azure Load Testing test run (status, results, statistics) from any
 * host.
 *
 * Binding assigns a custom role (`AzureLoadTestingReadTestRole`, one per
 * stack) with exactly the data action
 * `Microsoft.LoadTestService/loadtests/readTest/action`, on the load test
 * resource only. The smallest built-in role, **Load Test Reader**, also
 * grants `Microsoft.LoadTestService/*\/read` on the resource.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetTestRunHttp}.
 *
 * ### Calling GetTestRun
 * **Example:** GetTestRun from a Function
 * ```typescript
 * // init
 * const getTestRun = yield* Azure.LoadTesting.GetTestRun(loadTest);
 *
 * // runtime
 * const run = yield* getTestRun({ testRunId: "checkout-run-1" });
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface GetTestRun extends Binding.Service<
  GetTestRun,
  "Azure.LoadTesting.GetTestRun",
  (
    loadTest: LoadTest,
  ) => Effect.Effect<
    (
      request: GetTestRunRequest,
    ) => Effect.Effect<loadtesting.TestRun, loadtesting.GetLoadTestRunTestRunError, RuntimeContext>
  >
> {}

export const GetTestRun = Binding.Service<GetTestRun>("Azure.LoadTesting.GetTestRun");
