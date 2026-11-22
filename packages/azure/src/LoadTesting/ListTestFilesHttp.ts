import * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Layer from "effect/Layer";
import { makeLoadTestHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { ListTestFiles } from "./ListTestFiles.ts";

/**
 * Implementation of {@link ListTestFiles} over the distilled
 * `loadtesting-data` data plane. Assigns the custom
 * `AzureLoadTestingReadTestRole` on the load test resource.
 *
 * @layer
 * @provides Azure.LoadTesting.ListTestFiles
 */
export const ListTestFilesHttp = Layer.effect(
  ListTestFiles,
  makeLoadTestHttpBinding({
    tag: "Azure.LoadTesting.ListTestFiles",
    operation: loadtesting.ListLoadTestAdministrationTestFiles,
    grants: [LoadTestingRole.ReadTest],
  }),
);
