import * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Layer from "effect/Layer";
import { makeLoadTestHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { CreateOrUpdateTest } from "./CreateOrUpdateTest.ts";

/**
 * Implementation of {@link CreateOrUpdateTest} over the distilled
 * `loadtesting-data` data plane. Assigns the custom
 * `AzureLoadTestingWriteTestRole` on the load test resource.
 *
 * @layer
 * @provides Azure.LoadTesting.CreateOrUpdateTest
 */
export const CreateOrUpdateTestHttp = Layer.effect(
  CreateOrUpdateTest,
  makeLoadTestHttpBinding({
    tag: "Azure.LoadTesting.CreateOrUpdateTest",
    operation: loadtesting.LoadTestAdministrationCreateOrUpdateTest,
    grants: [LoadTestingRole.WriteTest],
  }),
);
