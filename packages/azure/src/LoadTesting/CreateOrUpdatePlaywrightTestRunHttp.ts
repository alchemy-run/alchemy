import * as playwright from "@distilled.cloud/azure/loadtesting-playwright";
import * as Layer from "effect/Layer";
import { makePlaywrightWorkspaceHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { CreateOrUpdatePlaywrightTestRun } from "./CreateOrUpdatePlaywrightTestRun.ts";

/**
 * Implementation of {@link CreateOrUpdatePlaywrightTestRun} over the
 * distilled `loadtesting-playwright` data plane. Assigns the custom
 * `AzureLoadTestingPlaywrightWriteTestRunsRole` on the workspace. Calls the
 * workspace's reporting host.
 *
 * @layer
 * @provides Azure.LoadTesting.CreateOrUpdatePlaywrightTestRun
 */
export const CreateOrUpdatePlaywrightTestRunHttp = Layer.effect(
  CreateOrUpdatePlaywrightTestRun,
  makePlaywrightWorkspaceHttpBinding({
    tag: "Azure.LoadTesting.CreateOrUpdatePlaywrightTestRun",
    operation: playwright.TestRunsCreateOrUpdate,
    grants: [LoadTestingRole.PlaywrightWriteTestRuns],
    service: "reporting",
  }),
);
