import type * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { LoadTest } from "./LoadTest.ts";

export interface StopTestRunRequest extends Omit<
  loadtesting.StopLoadTestRunTestRunRequest,
  "endpoint"
> {}

/**
 * Stop a running Azure Load Testing test run from any host.
 *
 * Binding assigns a custom role (`AzureLoadTestingStopTestRole`, one per
 * stack) with exactly the data action
 * `Microsoft.LoadTestService/loadtests/stopTest/action`, on the load test
 * resource only. The smallest built-in role, **Load Test Contributor**, also
 * grants `Microsoft.LoadTestService/*\/read` on the resource.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StopTestRunHttp}.
 *
 * ### Calling StopTestRun
 * **Example:** StopTestRun from a Function
 * ```typescript
 * // init
 * const stopTestRun = yield* Azure.LoadTesting.StopTestRun(loadTest);
 *
 * // runtime
 * const run = yield* stopTestRun({ testRunId: "checkout-run-1" });
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface StopTestRun extends Binding.Service<
  StopTestRun,
  "Azure.LoadTesting.StopTestRun",
  (
    loadTest: LoadTest,
  ) => Effect.Effect<
    (
      request: StopTestRunRequest,
    ) => Effect.Effect<loadtesting.TestRun, loadtesting.StopLoadTestRunTestRunError, RuntimeContext>
  >
> {}

export const StopTestRun = Binding.Service<StopTestRun>("Azure.LoadTesting.StopTestRun");
