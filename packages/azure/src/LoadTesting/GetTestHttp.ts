import * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Layer from "effect/Layer";
import { makeLoadTestHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { GetTest } from "./GetTest.ts";

/**
 * Implementation of {@link GetTest} over the distilled `loadtesting-data`
 * data plane. Assigns the custom `AzureLoadTestingReadTestRole` on the load
 * test resource.
 *
 * @layer
 * @provides Azure.LoadTesting.GetTest
 */
export const GetTestHttp = Layer.effect(
  GetTest,
  makeLoadTestHttpBinding({
    tag: "Azure.LoadTesting.GetTest",
    operation: loadtesting.GetLoadTestAdministrationTest,
    grants: [LoadTestingRole.ReadTest],
  }),
);
