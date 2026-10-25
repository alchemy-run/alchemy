import type * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { LoadTest } from "./LoadTest.ts";

export interface GetTestRunFileRequest extends Omit<
  loadtesting.GetLoadTestRunTestRunFileRequest,
  "endpoint"
> {}

/**
 * Read a file's metadata (blob URL, type, validation status) from an Azure
 * Load Testing test run from any host.
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
 * Provide {@link GetTestRunFileHttp}.
 *
 * ### Calling GetTestRunFile
 * **Example:** GetTestRunFile from a Function
 * ```typescript
 * // init
 * const getTestRunFile = yield* Azure.LoadTesting.GetTestRunFile(loadTest);
 *
 * // runtime
 * const file = yield* getTestRunFile({ testRunId: "checkout-run-1", fileName: "test.jmx" });
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface GetTestRunFile extends Binding.Service<
  GetTestRunFile,
  "Azure.LoadTesting.GetTestRunFile",
  (
    loadTest: LoadTest,
  ) => Effect.Effect<
    (
      request: GetTestRunFileRequest,
    ) => Effect.Effect<
      loadtesting.TestRunFileInfo,
      loadtesting.GetLoadTestRunTestRunFileError,
      RuntimeContext
    >
  >
> {}

export const GetTestRunFile = Binding.Service<GetTestRunFile>("Azure.LoadTesting.GetTestRunFile");
