import * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Layer from "effect/Layer";
import { makeLoadTestHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { ListTestRuns } from "./ListTestRuns.ts";

/**
 * Implementation of {@link ListTestRuns} over the distilled
 * `loadtesting-data` data plane. Assigns the custom
 * `AzureLoadTestingReadTestRole` on the load test resource.
 *
 * @layer
 * @provides Azure.LoadTesting.ListTestRuns
 */
export const ListTestRunsHttp = Layer.effect(
  ListTestRuns,
  makeLoadTestHttpBinding({
    tag: "Azure.LoadTesting.ListTestRuns",
    operation: loadtesting.ListLoadTestRunTestRuns,
    grants: [LoadTestingRole.ReadTest],
  }),
);
