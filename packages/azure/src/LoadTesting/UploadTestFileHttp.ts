import * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Layer from "effect/Layer";
import { makeLoadTestHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { UploadTestFile } from "./UploadTestFile.ts";

/**
 * Implementation of {@link UploadTestFile} over the distilled
 * `loadtesting-data` data plane. Assigns the custom
 * `AzureLoadTestingWriteTestRole` on the load test resource.
 *
 * @layer
 * @provides Azure.LoadTesting.UploadTestFile
 */
export const UploadTestFileHttp = Layer.effect(
  UploadTestFile,
  makeLoadTestHttpBinding({
    tag: "Azure.LoadTesting.UploadTestFile",
    operation: loadtesting.UploadLoadTestAdministrationTestFile,
    grants: [LoadTestingRole.WriteTest],
  }),
);
