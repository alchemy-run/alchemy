import * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Layer from "effect/Layer";
import { makeLoadTestHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { DeleteTestRun } from "./DeleteTestRun.ts";

/**
 * Implementation of {@link DeleteTestRun} over the distilled
 * `loadtesting-data` data plane. Assigns the custom
 * `AzureLoadTestingDeleteTestRole` on the load test resource.
 *
 * @layer
 * @provides Azure.LoadTesting.DeleteTestRun
 */
export const DeleteTestRunHttp = Layer.effect(
  DeleteTestRun,
  makeLoadTestHttpBinding({
    tag: "Azure.LoadTesting.DeleteTestRun",
    operation: loadtesting.DeleteLoadTestRunTestRun,
    grants: [LoadTestingRole.DeleteTest],
  }),
);
