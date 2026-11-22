import * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Layer from "effect/Layer";
import { makeLoadTestHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { StopTestRun } from "./StopTestRun.ts";

/**
 * Implementation of {@link StopTestRun} over the distilled `loadtesting-data`
 * data plane. Assigns the custom `AzureLoadTestingStopTestRole` on the load
 * test resource.
 *
 * @layer
 * @provides Azure.LoadTesting.StopTestRun
 */
export const StopTestRunHttp = Layer.effect(
  StopTestRun,
  makeLoadTestHttpBinding({
    tag: "Azure.LoadTesting.StopTestRun",
    operation: loadtesting.StopLoadTestRunTestRun,
    grants: [LoadTestingRole.StopTest],
  }),
);
