/**
 * `@alchemy.run/frontend-frameworks/tanstack-start/azure` — the Azure
 * Functions deploy target for the TanStack Start integration
 * (`Azure.Website.TanStackStart`).
 *
 * It reuses the Node target's build (the project's own `vite build` in a
 * disposable child, with a self-contained SSR bundle) and replaces its
 * listening wrapper with `server/serve-azure.mjs`, a Fetch module
 * (`export default { fetch(request) }`) around TanStack Start's server
 * entry. `Azure.Functions.Function` bundles that module; Front Door serves
 * the `client` directory from Blob Storage and sends every other path to
 * the Function.
 */
import { makeAzureTarget } from "../core/AzureServe.ts";
import { makeNodeTarget, type TanStackStartNodeTargetConfig } from "./node.ts";

export { SERVER_ENTRY_FILE_NAME } from "./node.ts";

/** Azure-specific knobs carried on the shared TanStack Start target config. */
export interface TanStackStartAzureTargetConfig extends TanStackStartNodeTargetConfig {}

/** TanStack Start production requests served by an Azure Functions Fetch handler. */
export const target = (config?: TanStackStartAzureTargetConfig) =>
  makeAzureTarget(makeNodeTarget(config));

export default target;
