import type * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { LoadTest } from "./LoadTest.ts";

export interface ListTestFilesRequest extends Omit<
  loadtesting.ListLoadTestAdministrationTestFilesRequest,
  "endpoint"
> {}

/**
 * List the files of an Azure Load Testing test (one page; pass `nextLink` for
 * the next) from any host.
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
 * Provide {@link ListTestFilesHttp}.
 *
 * ### Calling ListTestFiles
 * **Example:** ListTestFiles from a Function
 * ```typescript
 * // init
 * const listTestFiles = yield* Azure.LoadTesting.ListTestFiles(loadTest);
 *
 * // runtime
 * const page = yield* listTestFiles({ testId: "checkout" });
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface ListTestFiles extends Binding.Service<
  ListTestFiles,
  "Azure.LoadTesting.ListTestFiles",
  (
    loadTest: LoadTest,
  ) => Effect.Effect<
    (
      request: ListTestFilesRequest,
    ) => Effect.Effect<
      loadtesting.PagedTestFileInfo,
      loadtesting.ListLoadTestAdministrationTestFilesError,
      RuntimeContext
    >
  >
> {}

export const ListTestFiles = Binding.Service<ListTestFiles>("Azure.LoadTesting.ListTestFiles");
