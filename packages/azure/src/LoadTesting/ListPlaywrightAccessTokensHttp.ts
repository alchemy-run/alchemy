import * as playwright from "@distilled.cloud/azure/loadtesting-playwright";
import * as Layer from "effect/Layer";
import { makePlaywrightWorkspaceHttpBinding, LoadTestingRole } from "./BindingHttp.ts";
import { ListPlaywrightAccessTokens } from "./ListPlaywrightAccessTokens.ts";

/**
 * Implementation of {@link ListPlaywrightAccessTokens} over the distilled
 * `loadtesting-playwright` data plane. Assigns the custom
 * `AzureLoadTestingPlaywrightReadRole` on the workspace.
 *
 * @layer
 * @provides Azure.LoadTesting.ListPlaywrightAccessTokens
 */
export const ListPlaywrightAccessTokensHttp = Layer.effect(
  ListPlaywrightAccessTokens,
  makePlaywrightWorkspaceHttpBinding({
    tag: "Azure.LoadTesting.ListPlaywrightAccessTokens",
    operation: playwright.ListAccessTokens,
    grants: [LoadTestingRole.PlaywrightRead],
  }),
);
