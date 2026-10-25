import * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Layer from "effect/Layer";
import { makeLoadTestHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { DeleteTest } from "./DeleteTest.ts";

/**
 * Implementation of {@link DeleteTest} over the distilled `loadtesting-data`
 * data plane. Assigns the custom `AzureLoadTestingDeleteTestRole` on the load
 * test resource.
 *
 * @layer
 * @provides Azure.LoadTesting.DeleteTest
 */
export const DeleteTestHttp = Layer.effect(
  DeleteTest,
  makeLoadTestHttpBinding({
    tag: "Azure.LoadTesting.DeleteTest",
    operation: loadtesting.DeleteLoadTestAdministrationTest,
    grants: [LoadTestingRole.DeleteTest],
  }),
);
