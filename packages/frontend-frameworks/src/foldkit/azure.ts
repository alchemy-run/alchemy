/**
 * `@alchemy.run/frontend-frameworks/foldkit/azure` — the Azure Functions
 * deploy target for the Foldkit integration (`Azure.Website.Foldkit`).
 *
 * It reuses the Node target's child-process build and swaps the listening
 * Node program for an Azure Functions Fetch entry (`serve-azure.mjs`,
 * `export default { fetch(request) }`) that calls Foldkit's generated
 * request handler. Front Door serves the client directory from Blob
 * Storage, so the entry carries no static file server. Browser-only and
 * prerendered builds deploy their client directory only.
 */
import { makeAzureTarget as wrapAzureTarget } from "../core/AzureServe.ts";
import type { FoldkitTarget, FoldkitTargetConfig } from "./Foldkit.ts";
import { makeNodeTarget } from "./node.ts";

export const makeAzureTarget = (config: FoldkitTargetConfig = {}): FoldkitTarget =>
  wrapAzureTarget(makeNodeTarget(config));
export const target = makeAzureTarget;
export default makeAzureTarget;
