import type * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { LoadTest } from "./LoadTest.ts";

export interface GetTestFileRequest extends Omit<
  loadtesting.GetLoadTestAdministrationTestFileRequest,
  "endpoint"
> {}

/**
 * Read a file's metadata (blob URL, type, validation status) from an Azure
 * Load Testing test from any host.
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
 * Provide {@link GetTestFileHttp}.
 *
 * ### Calling GetTestFile
 * **Example:** GetTestFile from a Function
 * ```typescript
 * // init
 * const getTestFile = yield* Azure.LoadTesting.GetTestFile(loadTest);
 *
 * // runtime
 * const file = yield* getTestFile({ testId: "checkout", fileName: "users.csv" });
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface GetTestFile extends Binding.Service<
  GetTestFile,
  "Azure.LoadTesting.GetTestFile",
  (
    loadTest: LoadTest,
  ) => Effect.Effect<
    (
      request: GetTestFileRequest,
    ) => Effect.Effect<
      loadtesting.TestFileInfo,
      loadtesting.GetLoadTestAdministrationTestFileError,
      RuntimeContext
    >
  >
> {}

export const GetTestFile = Binding.Service<GetTestFile>("Azure.LoadTesting.GetTestFile");
