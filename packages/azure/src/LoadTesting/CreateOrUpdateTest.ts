import type * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { LoadTest } from "./LoadTest.ts";

export interface CreateOrUpdateTestRequest extends Omit<
  loadtesting.LoadTestAdministrationCreateOrUpdateTestRequest,
  "endpoint"
> {}

/**
 * Create or update an Azure Load Testing test (its load, pass/fail criteria,
 * and environment) from any host.
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
 * Provide {@link CreateOrUpdateTestHttp}.
 *
 * ### Calling CreateOrUpdateTest
 * **Example:** CreateOrUpdateTest from a Function
 * ```typescript
 * // init
 * const createOrUpdateTest = yield* Azure.LoadTesting.CreateOrUpdateTest(loadTest);
 *
 * // runtime
 * const test = yield* createOrUpdateTest({
 *   testId: "checkout",
 *   displayName: "Checkout",
 *   kind: "JMX",
 *   loadTestConfiguration: { engineInstances: 1 },
 * });
 * ```
 *
 * @binding
 * @category LoadTesting
 */
export interface CreateOrUpdateTest extends Binding.Service<
  CreateOrUpdateTest,
  "Azure.LoadTesting.CreateOrUpdateTest",
  (
    loadTest: LoadTest,
  ) => Effect.Effect<
    (
      request: CreateOrUpdateTestRequest,
    ) => Effect.Effect<
      loadtesting.Test,
      loadtesting.LoadTestAdministrationCreateOrUpdateTestError,
      RuntimeContext
    >
  >
> {}

export const CreateOrUpdateTest = Binding.Service<CreateOrUpdateTest>(
  "Azure.LoadTesting.CreateOrUpdateTest",
);
