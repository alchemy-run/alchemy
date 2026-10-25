import * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Layer from "effect/Layer";
import { makeLoadTestHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { ListTests } from "./ListTests.ts";

/**
 * Implementation of {@link ListTests} over the distilled `loadtesting-data`
 * data plane. Assigns the custom `AzureLoadTestingReadTestRole` on the load
 * test resource.
 *
 * @layer
 * @provides Azure.LoadTesting.ListTests
 */
export const ListTestsHttp = Layer.effect(
  ListTests,
  makeLoadTestHttpBinding({
    tag: "Azure.LoadTesting.ListTests",
    operation: loadtesting.ListLoadTestAdministrationTests,
    grants: [LoadTestingRole.ReadTest],
  }),
);
