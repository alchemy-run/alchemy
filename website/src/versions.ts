import rootPkg from "../../package.json";
import alchemyPkg from "../../packages/alchemy/package.json";

export const alchemyVersion = alchemyPkg.version;
export const effectVersion = rootPkg.workspaces.catalog.effect;
export const cloudflareWorkersTypesVersion =
  rootPkg.workspaces.catalog["@cloudflare/workers-types"];
export const distilledCloudflareVersion =
  rootPkg.workspaces.catalog["@distilled.cloud/cloudflare"];
export const distilledCloudflareRuntimeVersion =
  rootPkg.workspaces.catalog["@distilled.cloud/cloudflare-runtime"];
export const distilledCloudflareVitePluginVersion =
  rootPkg.workspaces.catalog["@distilled.cloud/cloudflare-vite-plugin"];
export const distilledCloudflareRolldownPluginVersion =
  rootPkg.workspaces.catalog["@distilled.cloud/cloudflare-rolldown-plugin"];
export const distilledAwsVersion =
  rootPkg.workspaces.catalog["@distilled.cloud/aws"];
export const sondaVersion = rootPkg.workspaces.catalog.sonda;
export const viteVersion = rootPkg.workspaces.catalog.vite;
