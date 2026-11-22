import * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Layer from "effect/Layer";
import { makeLoadTestHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { GetTestRun } from "./GetTestRun.ts";

/**
 * Implementation of {@link GetTestRun} over the distilled `loadtesting-data`
 * data plane. Assigns the custom `AzureLoadTestingReadTestRole` on the load
 * test resource.
 *
 * @layer
 * @provides Azure.LoadTesting.GetTestRun
 */
export const GetTestRunHttp = Layer.effect(
  GetTestRun,
  makeLoadTestHttpBinding({
    tag: "Azure.LoadTesting.GetTestRun",
    operation: loadtesting.GetLoadTestRunTestRun,
    grants: [LoadTestingRole.ReadTest],
  }),
);
