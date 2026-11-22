import type * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { LoadTest } from "./LoadTest.ts";

export interface DeleteTestFileRequest extends Omit<
  loadtesting.DeleteLoadTestAdministrationTestFileRequest,
  "endpoint"
> {}

/**
 * Delete a file from an Azure Load Testing test from any host.
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
 * Provide {@link DeleteTestFileHttp}.
 *
 * ### Calling DeleteTestFile
 * **Example:** DeleteTestFile from a Function
 * ```typescript
 * // init
 * const deleteTestFile = yield* Azure.LoadTesting.DeleteTestFile(loadTest);
 *
 * // runtime
 * yield* deleteTestFile({ testId: "checkout", fileName: "users.csv" });
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface DeleteTestFile extends Binding.Service<
  DeleteTestFile,
  "Azure.LoadTesting.DeleteTestFile",
  (
    loadTest: LoadTest,
  ) => Effect.Effect<
    (
      request: DeleteTestFileRequest,
    ) => Effect.Effect<
      loadtesting.DeleteLoadTestAdministrationTestFileResponse,
      loadtesting.DeleteLoadTestAdministrationTestFileError,
      RuntimeContext
    >
  >
> {}

export const DeleteTestFile = Binding.Service<DeleteTestFile>("Azure.LoadTesting.DeleteTestFile");
