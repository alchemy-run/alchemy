import type * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { LoadTest } from "./LoadTest.ts";

export interface GetTestRequest extends Omit<
  loadtesting.GetLoadTestAdministrationTestRequest,
  "endpoint"
> {}

/**
 * Read an Azure Load Testing test from any host.
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
 * Provide {@link GetTestHttp}.
 *
 * ### Calling GetTest
 * **Example:** GetTest from a Function
 * ```typescript
 * // init
 * const getTest = yield* Azure.LoadTesting.GetTest(loadTest);
 *
 * // runtime
 * const test = yield* getTest({ testId: "checkout" });
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface GetTest extends Binding.Service<
  GetTest,
  "Azure.LoadTesting.GetTest",
  (
    loadTest: LoadTest,
  ) => Effect.Effect<
    (
      request: GetTestRequest,
    ) => Effect.Effect<
      loadtesting.Test,
      loadtesting.GetLoadTestAdministrationTestError,
      RuntimeContext
    >
  >
> {}

export const GetTest = Binding.Service<GetTest>("Azure.LoadTesting.GetTest");
