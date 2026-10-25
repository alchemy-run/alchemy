import type * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { LoadTest } from "./LoadTest.ts";

export interface DeleteTestRequest extends Omit<
  loadtesting.DeleteLoadTestAdministrationTestRequest,
  "endpoint"
> {}

/**
 * Delete an Azure Load Testing test, with its files and runs, from any host.
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
 * Provide {@link DeleteTestHttp}.
 *
 * ### Calling DeleteTest
 * **Example:** DeleteTest from a Function
 * ```typescript
 * // init
 * const deleteTest = yield* Azure.LoadTesting.DeleteTest(loadTest);
 *
 * // runtime
 * yield* deleteTest({ testId: "checkout" });
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface DeleteTest extends Binding.Service<
  DeleteTest,
  "Azure.LoadTesting.DeleteTest",
  (
    loadTest: LoadTest,
  ) => Effect.Effect<
    (
      request: DeleteTestRequest,
    ) => Effect.Effect<
      loadtesting.DeleteLoadTestAdministrationTestResponse,
      loadtesting.DeleteLoadTestAdministrationTestError,
      RuntimeContext
    >
  >
> {}

export const DeleteTest = Binding.Service<DeleteTest>("Azure.LoadTesting.DeleteTest");
