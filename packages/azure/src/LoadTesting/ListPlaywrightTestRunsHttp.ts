import * as playwright from "@distilled.cloud/azure/loadtesting-playwright";
import * as Layer from "effect/Layer";
import { makePlaywrightWorkspaceHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { ListPlaywrightTestRuns } from "./ListPlaywrightTestRuns.ts";

/**
 * Implementation of {@link ListPlaywrightTestRuns} over the distilled
 * `loadtesting-playwright` data plane. Assigns the custom
 * `AzureLoadTestingPlaywrightReadTestRunsRole` on the workspace. Calls the
 * workspace's reporting host.
 *
 * @layer
 * @provides Azure.LoadTesting.ListPlaywrightTestRuns
 */
export const ListPlaywrightTestRunsHttp = Layer.effect(
  ListPlaywrightTestRuns,
  makePlaywrightWorkspaceHttpBinding({
    tag: "Azure.LoadTesting.ListPlaywrightTestRuns",
    operation: playwright.ListTestRuns,
    grants: [LoadTestingRole.PlaywrightReadTestRuns],
    service: "reporting",
  }),
);
