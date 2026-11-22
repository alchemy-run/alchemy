import * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Layer from "effect/Layer";
import { makeLoadTestHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { GetTestFile } from "./GetTestFile.ts";

/**
 * Implementation of {@link GetTestFile} over the distilled `loadtesting-data`
 * data plane. Assigns the custom `AzureLoadTestingReadTestRole` on the load
 * test resource.
 *
 * @layer
 * @provides Azure.LoadTesting.GetTestFile
 */
export const GetTestFileHttp = Layer.effect(
  GetTestFile,
  makeLoadTestHttpBinding({
    tag: "Azure.LoadTesting.GetTestFile",
    operation: loadtesting.GetLoadTestAdministrationTestFile,
    grants: [LoadTestingRole.ReadTest],
  }),
);
