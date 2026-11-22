import type * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { LoadTest } from "./LoadTest.ts";

export interface ListTestRunsRequest extends Omit<
  loadtesting.ListLoadTestRunTestRunsRequest,
  "endpoint"
> {}

/**
 * List the test runs of an Azure Load Testing resource (one page; pass
 * `nextLink` for the next) from any host.
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
 * Provide {@link ListTestRunsHttp}.
 *
 * ### Calling ListTestRuns
 * **Example:** ListTestRuns from a Function
 * ```typescript
 * // init
 * const listTestRuns = yield* Azure.LoadTesting.ListTestRuns(loadTest);
 *
 * // runtime
 * const page = yield* listTestRuns({ testId: "checkout" });
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface ListTestRuns extends Binding.Service<
  ListTestRuns,
  "Azure.LoadTesting.ListTestRuns",
  (
    loadTest: LoadTest,
  ) => Effect.Effect<
    (
      request?: ListTestRunsRequest,
    ) => Effect.Effect<
      loadtesting.PagedTestRun,
      loadtesting.ListLoadTestRunTestRunsError,
      RuntimeContext
    >
  >
> {}

export const ListTestRuns = Binding.Service<ListTestRuns>("Azure.LoadTesting.ListTestRuns");
