import type * as web from "@distilled.cloud/azure/web";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { lower } from "./common.ts";
import {
  makeSiteLifecycle,
  type SiteAttributes,
  type SiteProps,
} from "./Site.ts";

/** Language worker of a function app. */
export type FunctionRuntimeName =
  | "node"
  | "python"
  | "dotnet-isolated"
  | "java"
  | "powershell"
  | "custom";

/** Language runtime of a function app. */
export interface FunctionRuntime {
  /** Language worker, e.g. `node`. */
  name: FunctionRuntimeName;
  /** Language version, e.g. `20` for Node.js 20 (Flex Consumption only). */
  version?: string;
}

/** How a Flex Consumption app authenticates to its deployment storage. */
export interface FlexDeploymentStorageAuthentication {
  /** Authentication type. */
  type:
    | "SystemAssignedIdentity"
    | "UserAssignedIdentity"
    | "StorageAccountConnectionString";
  /** ARM ID of the user-assigned identity (for `UserAssignedIdentity`). */
  userAssignedIdentityResourceId?: string;
  /**
   * Name of the app setting that holds the storage connection string (for
   * `StorageAccountConnectionString`).
   */
  storageAccountConnectionStringName?: string;
}

/** Flex Consumption (`FC1` plan) settings of a function app. */
export interface FlexConsumptionConfig {
  /**
   * URL of the blob container the deployment package is uploaded to, e.g.
   * `https://{account}.blob.core.windows.net/{container}`. Changing it
   * replaces the app.
   */
  deploymentStorageUrl: string;
  /** How the app authenticates to the deployment storage. */
  deploymentStorageAuthentication: FlexDeploymentStorageAuthentication;
  /**
   * Maximum number of instances the app scales out to (40-1000).
   * @default 100
   */
  maximumInstanceCount?: number;
  /**
   * Memory per instance in MB (`512`, `2048`, or `4096`).
   * @default 2048
   */
  instanceMemoryMB?: number;
}

export interface FunctionAppProps extends SiteProps {
  /**
   * Language runtime. On Flex Consumption it sets `functionAppConfig.runtime`;
   * on other plans it sets the `FUNCTIONS_WORKER_RUNTIME` app setting (set
   * the language version with `siteConfig.linuxFxVersion`, e.g.
   * `Node|20`).
   */
  runtime?: FunctionRuntime;
  /**
   * Functions host version (`FUNCTIONS_EXTENSION_VERSION`). Ignored on
   * Flex Consumption, which always runs the latest host.
   * @default "~4"
   */
  functionsExtensionVersion?: string;
  /**
   * Flex Consumption settings. Required when the plan's SKU is `FC1`;
   * adding or removing it replaces the app.
   */
  flexConsumption?: FlexConsumptionConfig;
}

export interface FunctionApp extends Resource<
  "Azure.Web.FunctionApp",
  FunctionAppProps,
  SiteAttributes,
  never,
  Providers
> {}

/**
 * An Azure Functions app (`Microsoft.Web/sites`, kind `functionapp`) on a
 * Flex Consumption, Consumption, Elastic Premium, or dedicated App Service
 * plan.
 *
 * The Functions host needs a storage account: set the `AzureWebJobsStorage`
 * app setting (a connection string, or `AzureWebJobsStorage__accountName`
 * with an identity that holds Storage Blob Data Owner).
 *
 * @see https://learn.microsoft.com/azure/azure-functions/functions-overview
 *
 * ### Flex Consumption
 * **Example:** Node.js function app on a Flex Consumption plan
 * ```typescript
 * const plan = yield* Azure.Web.AppServicePlan("functions", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "FC1",
 * });
 * const app = yield* Azure.Web.FunctionApp("api", {
 *   resourceGroup: group.resourceGroupName,
 *   serverFarmId: plan.appServicePlanId,
 *   runtime: { name: "node", version: "20" },
 *   flexConsumption: {
 *     deploymentStorageUrl: Output.interpolate`${account.primaryEndpoints.blob}${container.containerName}`,
 *     deploymentStorageAuthentication: {
 *       type: "StorageAccountConnectionString",
 *       storageAccountConnectionStringName: "AzureWebJobsStorage",
 *     },
 *   },
 *   appSettings: { AzureWebJobsStorage: connectionString },
 * });
 * ```
 *
 * ### Consumption and Dedicated Plans
 * **Example:** Linux function app on a Consumption plan
 * ```typescript
 * const plan = yield* Azure.Web.AppServicePlan("functions", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Y1",
 * });
 * const app = yield* Azure.Web.FunctionApp("api", {
 *   resourceGroup: group.resourceGroupName,
 *   serverFarmId: plan.appServicePlanId,
 *   runtime: { name: "python" },
 *   siteConfig: { linuxFxVersion: "Python|3.12" },
 *   appSettings: { AzureWebJobsStorage: connectionString },
 * });
 * ```
 *
 * @resource
 */
export const FunctionApp = Resource<FunctionApp>("Azure.Web.FunctionApp");

const functionAppConfig = (
  flex: FlexConsumptionConfig,
  runtime: FunctionRuntime | undefined,
): web.FunctionAppConfig => ({
  deployment: {
    storage: {
      type: "blobContainer",
      value: flex.deploymentStorageUrl,
      authentication: flex.deploymentStorageAuthentication,
    },
  },
  runtime: runtime
    ? { name: runtime.name, version: runtime.version }
    : undefined,
  // Flex Consumption requires both scale settings on every PUT.
  scaleAndConcurrency: {
    maximumInstanceCount: flex.maximumInstanceCount ?? 100,
    instanceMemoryMB: flex.instanceMemoryMB ?? 2048,
  },
});

const lifecycle = makeSiteLifecycle<FunctionAppProps>({
  kind: "functionapp",
  // The Functions host ID is the first 32 characters of the app name; two
  // apps sharing a storage account must differ within them.
  maxNameLength: 32,
  // Flex Consumption rejects the classic worker/host settings.
  platformAppSettings: (props) =>
    props.flexConsumption
      ? {}
      : {
          FUNCTIONS_EXTENSION_VERSION: props.functionsExtensionVersion ?? "~4",
          ...(props.runtime
            ? { FUNCTIONS_WORKER_RUNTIME: props.runtime.name }
            : {}),
        },
  putOnlyProperties: (props) =>
    props.flexConsumption
      ? {
          functionAppConfig: functionAppConfig(
            props.flexConsumption,
            props.runtime,
          ),
        }
      : {},
  replaces: (news, olds) =>
    olds !== undefined &&
    ((news.flexConsumption === undefined) !==
      (olds.flexConsumption === undefined) ||
      lower(news.flexConsumption?.deploymentStorageUrl) !==
        lower(olds.flexConsumption?.deploymentStorageUrl)),
  // A Flex Consumption plan hosts exactly one app, so a replacement on the
  // same plan must delete the old app first.
  deleteFirst: (news, output) =>
    news.flexConsumption !== undefined &&
    lower(news.serverFarmId) === lower(output.serverFarmId),
});

export const FunctionAppProvider = () =>
  Provider.succeed(FunctionApp, {
    ...lifecycle,
    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Web.AppServicePlan"],
    },
  });
