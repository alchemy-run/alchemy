import * as playwright from "@distilled.cloud/azure/loadtesting-playwright";
import * as Layer from "effect/Layer";
import { makePlaywrightWorkspaceHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { DeletePlaywrightAccessToken } from "./DeletePlaywrightAccessToken.ts";

/**
 * Implementation of {@link DeletePlaywrightAccessToken} over the distilled
 * `loadtesting-playwright` data plane. Assigns the custom
 * `AzureLoadTestingPlaywrightAccessTokensRole` on the workspace.
 *
 * @layer
 * @provides Azure.LoadTesting.DeletePlaywrightAccessToken
 */
export const DeletePlaywrightAccessTokenHttp = Layer.effect(
  DeletePlaywrightAccessToken,
  makePlaywrightWorkspaceHttpBinding({
    tag: "Azure.LoadTesting.DeletePlaywrightAccessToken",
    operation: playwright.DeleteAccessToken,
    grants: [LoadTestingRole.PlaywrightAccessTokens],
  }),
);
