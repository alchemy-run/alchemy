import * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Layer from "effect/Layer";
import { makeLoadTestHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { GetTestRunFile } from "./GetTestRunFile.ts";

/**
 * Implementation of {@link GetTestRunFile} over the distilled
 * `loadtesting-data` data plane. Assigns the custom
 * `AzureLoadTestingReadTestRole` on the load test resource.
 *
 * @layer
 * @provides Azure.LoadTesting.GetTestRunFile
 */
export const GetTestRunFileHttp = Layer.effect(
  GetTestRunFile,
  makeLoadTestHttpBinding({
    tag: "Azure.LoadTesting.GetTestRunFile",
    operation: loadtesting.GetLoadTestRunTestRunFile,
    grants: [LoadTestingRole.ReadTest],
  }),
);
