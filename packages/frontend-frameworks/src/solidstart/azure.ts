/**
 * `@alchemy.run/frontend-frameworks/solidstart/azure` — the Azure Functions
 * deploy target for the SolidStart integration.
 *
 * `Azure.Website.SolidStart` selects this target. It reuses the Node
 * target's build (the project's `vite build` with nitro's `node-listener`
 * preset, in a child process) and replaces the listening wrapper with
 * `serve-azure.mjs`, a Fetch module (`export default { fetch }`) that adapts
 * nitro's Node `handler` and that `Azure.Functions.Function` bundles.
 *
 * Front Door serves `.output/public` (client assets and prerendered pages)
 * from Blob Storage and sends every other path to the Function. The
 * `node-listener` preset leaves nitro's static-file handler out, so a
 * prerendered route that reaches the Function (`/about` for
 * `about/index.html`) renders through SolidStart's SSR.
 */
import { makeAzureTarget } from "../core/AzureServe.ts";
import { makeNodeTarget, type SolidStartNodeTargetConfig } from "./node.ts";

/** SolidStart's nitro handler served by an Azure Functions Fetch handler. */
export const target = (config?: SolidStartNodeTargetConfig) =>
  makeAzureTarget(makeNodeTarget(config));

export default target;
