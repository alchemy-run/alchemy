import * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as Layer from "effect/Layer";
import { makeLoadTestHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { CreateOrUpdateTestRun } from "./CreateOrUpdateTestRun.ts";

/**
 * Implementation of {@link CreateOrUpdateTestRun} over the distilled
 * `loadtesting-data` data plane. Assigns the custom
 * `AzureLoadTestingStartTestRole` on the load test resource.
 *
 * @layer
 * @provides Azure.LoadTesting.CreateOrUpdateTestRun
 */
export const CreateOrUpdateTestRunHttp = Layer.effect(
  CreateOrUpdateTestRun,
  makeLoadTestHttpBinding({
    tag: "Azure.LoadTesting.CreateOrUpdateTestRun",
    operation: loadtesting.LoadTestRunCreateOrUpdateTestRun,
    grants: [LoadTestingRole.StartTest],
  }),
);
