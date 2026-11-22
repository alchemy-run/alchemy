import * as playwright from "@distilled.cloud/azure/loadtesting-playwright";
import * as Layer from "effect/Layer";
import { makePlaywrightWorkspaceHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { CreatePlaywrightAccessToken } from "./CreatePlaywrightAccessToken.ts";

/**
 * Implementation of {@link CreatePlaywrightAccessToken} over the distilled
 * `loadtesting-playwright` data plane. Assigns the custom
 * `AzureLoadTestingPlaywrightAccessTokensRole` on the workspace.
 *
 * @layer
 * @provides Azure.LoadTesting.CreatePlaywrightAccessToken
 */
export const CreatePlaywrightAccessTokenHttp = Layer.effect(
  CreatePlaywrightAccessToken,
  makePlaywrightWorkspaceHttpBinding({
    tag: "Azure.LoadTesting.CreatePlaywrightAccessToken",
    operation: playwright.AccessTokensCreateOrReplace,
    grants: [LoadTestingRole.PlaywrightAccessTokens],
  }),
);
