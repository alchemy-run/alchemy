/**
 * `@alchemy.run/frontend-frameworks/react-router/azure` — the Azure
 * Functions deploy target for the React Router v7 integration.
 *
 * `Azure.Website.ReactRouter` selects this target. It reuses the Node
 * target's build (React Router's Vite build in a child process, the
 * `ServerBuild` manifest wrapped with `createRequestHandler`) and replaces
 * the listening wrapper with `serve-azure.mjs`, a Fetch module
 * (`export default { fetch }`) that `Azure.Functions.Function` bundles.
 * Front Door serves the client directory from Blob Storage, so the module
 * carries no static file server.
 */
import { makeAzureTarget } from "../core/AzureServe.ts";
import { makeNodeTarget, type ReactRouterNodeTargetConfig } from "./node.ts";

/** React Router loaders and actions served by an Azure Functions Fetch handler. */
export const target = (config?: ReactRouterNodeTargetConfig) =>
  makeAzureTarget(makeNodeTarget(config));

export default target;
