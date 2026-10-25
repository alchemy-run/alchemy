import type * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { LoadTest } from "./LoadTest.ts";

export interface UploadTestFileRequest extends Omit<
  loadtesting.UploadLoadTestAdministrationTestFileRequest,
  "endpoint"
> {}

/**
 * Upload a file (a JMeter script, a Locust script, a CSV, a properties file,
 * or a ZIP) to an Azure Load Testing test from any host. The service
 * validates a test script after the upload.
 *
 * Binding assigns a custom role (`AzureLoadTestingWriteTestRole`, one per
 * stack) with exactly the data action
 * `Microsoft.LoadTestService/loadtests/writeTest/action`, on the load test
 * resource only. The smallest built-in role, **Load Test Contributor**, also
 * grants `Microsoft.LoadTestService/*\/read` on the resource.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link UploadTestFileHttp}.
 *
 * ### Calling UploadTestFile
 * **Example:** UploadTestFile from a Function
 * ```typescript
 * // init
 * const uploadTestFile = yield* Azure.LoadTesting.UploadTestFile(loadTest);
 *
 * // runtime
 * const file = yield* uploadTestFile({
 *   testId: "checkout",
 *   fileName: "users.csv",
 *   fileType: "ADDITIONAL_ARTIFACTS",
 *   body: "user,password\nalice,secret\n",
 * });
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface UploadTestFile extends Binding.Service<
  UploadTestFile,
  "Azure.LoadTesting.UploadTestFile",
  (
    loadTest: LoadTest,
  ) => Effect.Effect<
    (
      request: UploadTestFileRequest,
    ) => Effect.Effect<
      loadtesting.TestFileInfo,
      loadtesting.UploadLoadTestAdministrationTestFileError,
      RuntimeContext
    >
  >
> {}

export const UploadTestFile = Binding.Service<UploadTestFile>("Azure.LoadTesting.UploadTestFile");
