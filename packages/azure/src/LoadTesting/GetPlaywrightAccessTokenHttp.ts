import * as playwright from "@distilled.cloud/azure/loadtesting-playwright";
import * as Layer from "effect/Layer";
import { makePlaywrightWorkspaceHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { GetPlaywrightAccessToken } from "./GetPlaywrightAccessToken.ts";

/**
 * Implementation of {@link GetPlaywrightAccessToken} over the distilled
 * `loadtesting-playwright` data plane. Assigns the custom
 * `AzureLoadTestingPlaywrightReadRole` on the workspace.
 *
 * @layer
 * @provides Azure.LoadTesting.GetPlaywrightAccessToken
 */
export const GetPlaywrightAccessTokenHttp = Layer.effect(
  GetPlaywrightAccessToken,
  makePlaywrightWorkspaceHttpBinding({
    tag: "Azure.LoadTesting.GetPlaywrightAccessToken",
    operation: playwright.GetAccessToken,
    grants: [LoadTestingRole.PlaywrightRead],
  }),
);
