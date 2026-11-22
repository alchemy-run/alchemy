import type * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { LoadTest } from "./LoadTest.ts";

export interface ListTestsRequest extends Omit<
  loadtesting.ListLoadTestAdministrationTestsRequest,
  "endpoint"
> {}

/**
 * List the tests of an Azure Load Testing resource (one page; pass `nextLink`
 * for the next) from any host.
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
 * Provide {@link ListTestsHttp}.
 *
 * ### Calling ListTests
 * **Example:** ListTests from a Function
 * ```typescript
 * // init
 * const listTests = yield* Azure.LoadTesting.ListTests(loadTest);
 *
 * // runtime
 * const page = yield* listTests({ search: "checkout" });
 * const ids = page.value.map((test) => test.testId);
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface ListTests extends Binding.Service<
  ListTests,
  "Azure.LoadTesting.ListTests",
  (
    loadTest: LoadTest,
  ) => Effect.Effect<
    (
      request?: ListTestsRequest,
    ) => Effect.Effect<
      loadtesting.PagedTest,
      loadtesting.ListLoadTestAdministrationTestsError,
      RuntimeContext
    >
  >
> {}

export const ListTests = Binding.Service<ListTests>("Azure.LoadTesting.ListTests");
