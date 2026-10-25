import type * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { LoadTest } from "./LoadTest.ts";

export interface CreateOrUpdateTestRunRequest extends Omit<
  loadtesting.LoadTestRunCreateOrUpdateTestRunRequest,
  "endpoint"
> {}

/**
 * Start a run of an Azure Load Testing test (create a test run) from any
 * host. A run bills virtual-user hours.
 *
 * Binding assigns a custom role (`AzureLoadTestingStartTestRole`, one per
 * stack) with exactly the data action
 * `Microsoft.LoadTestService/loadtests/startTest/action`, on the load test
 * resource only. The smallest built-in role, **Load Test Contributor**, also
 * grants `Microsoft.LoadTestService/*\/read` on the resource.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CreateOrUpdateTestRunHttp}.
 *
 * ### Calling CreateOrUpdateTestRun
 * **Example:** CreateOrUpdateTestRun from a Function
 * ```typescript
 * // init
 * const createOrUpdateTestRun = yield* Azure.LoadTesting.CreateOrUpdateTestRun(loadTest);
 *
 * // runtime
 * const run = yield* createOrUpdateTestRun({
 *   testRunId: "checkout-run-1",
 *   testId: "checkout",
 *   displayName: "Nightly",
 * });
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface CreateOrUpdateTestRun extends Binding.Service<
  CreateOrUpdateTestRun,
  "Azure.LoadTesting.CreateOrUpdateTestRun",
  (
    loadTest: LoadTest,
  ) => Effect.Effect<
    (
      request: CreateOrUpdateTestRunRequest,
    ) => Effect.Effect<
      loadtesting.TestRun,
      loadtesting.LoadTestRunCreateOrUpdateTestRunError,
      RuntimeContext
    >
  >
> {}

export const CreateOrUpdateTestRun = Binding.Service<CreateOrUpdateTestRun>(
  "Azure.LoadTesting.CreateOrUpdateTestRun",
);
