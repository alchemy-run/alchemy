import * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Layer from "effect/Layer";
import { makeLoadTestHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { DeleteTestFile } from "./DeleteTestFile.ts";

/**
 * Implementation of {@link DeleteTestFile} over the distilled
 * `loadtesting-data` data plane. Assigns the custom
 * `AzureLoadTestingWriteTestRole` on the load test resource.
 *
 * @layer
 * @provides Azure.LoadTesting.DeleteTestFile
 */
export const DeleteTestFileHttp = Layer.effect(
  DeleteTestFile,
  makeLoadTestHttpBinding({
    tag: "Azure.LoadTesting.DeleteTestFile",
    operation: loadtesting.DeleteLoadTestAdministrationTestFile,
    grants: [LoadTestingRole.WriteTest],
  }),
);
