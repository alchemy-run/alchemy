import type { Credentials } from "@distilled.cloud/azure";
import * as web from "@distilled.cloud/azure/web";
import { Unowned } from "alchemy/AdoptPolicy";
import type * as Bundle from "alchemy/Bundle/Bundle";
import { isResolved } from "alchemy/Diff";
import type { InputProps } from "alchemy/Input";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource, ResourceBinding } from "alchemy/Resource";
import { Self } from "alchemy/Self";
import { Stack } from "alchemy/Stack";
import { zipFiles } from "alchemy/Util/zip";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { orUndefinedIfNotFound, resourceGroupOf } from "../Arm.ts";
import { syncBindingAssignments } from "../ContainerApps/ContainerApp.ts";
import { AzureEnvironment } from "../Environment.ts";
import {
  FunctionTypeId,
  type Function,
  type FunctionBinding,
  type FunctionRuntimeContext,
} from "../Functions/Function.ts";
import {
  collectBindings,
  deployPackage,
  envString,
  HOST_STORAGE_ROLES,
  makeBundler,
  makeFunctionsRuntimeContext,
  scmHostOf,
  syncEventSubscriptions,
  waitForFunctions,
} from "../Functions/host/internal.ts";
import type { Providers } from "../Providers.ts";
import { stackResourceGroup } from "../StackResourceGroup.ts";
import { lower, nameOf } from "./common.ts";
import {
  getSite,
  makeSiteLifecycle,
  type SiteAttributes,
  type SiteIdentity,
  type SiteProps,
} from "./Site.ts";

export const FunctionAppTypeId = "Azure.Web.FunctionApp" as const;
export type FunctionAppTypeId = typeof FunctionAppTypeId;

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
  /** Language version, e.g. `22` for Node.js 22 (Flex Consumption only). */
  version?: string;
}

/** How a Flex Consumption app authenticates to its deployment storage. */
export interface FlexDeploymentStorageAuthentication {
  /** Authentication type. */
  type: "SystemAssignedIdentity" | "UserAssignedIdentity" | "StorageAccountConnectionString";
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

export interface FunctionAppProps<Env extends Record<string, any> = Record<string, any>>
  extends Omit<SiteProps, "resourceGroup">, PlatformProps {
  /**
   * Resource group the app is created in. Changing it replaces the app.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup?: string;
  /**
   * Language runtime. On Flex Consumption it sets `functionAppConfig.runtime`;
   * on other plans it sets the `FUNCTIONS_WORKER_RUNTIME` app setting (set
   * the language version with `siteConfig.linuxFxVersion`, e.g.
   * `Node|22`). With `main` it must be `node`.
   * @default `{ name: "node", version: "22" }` when `main` is set
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
  /**
   * ARM ID of the storage account the Functions host uses. Alchemy sets
   * `AzureWebJobsStorage__accountName` and grants the app's system-assigned
   * identity Storage Blob Data Owner, Storage Queue Data Contributor, and
   * Storage Table Data Contributor on the account, so the host needs no
   * connection string. Enables the system-assigned identity.
   */
  hostStorageAccountId?: string;
  /**
   * Entry module of a program Alchemy bundles and deploys onto the app. For
   * an Effect function app this is `import.meta.url` (the file is both the
   * bundle entry and the program). For an async function app it is a
   * handler file that default-exports `{ fetch(request, env) }`. Alchemy
   * bundles it for Node.js into one ESM file and zip-deploys it with Kudu
   * OneDeploy. The app then runs as its system-assigned identity. Outside
   * Flex Consumption the app runs from the package
   * (`WEBSITE_RUN_FROM_PACKAGE=1`), and dedicated plans get Always On so
   * timers and queue triggers fire.
   *
   * Omit it to manage only the app's configuration and deploy code another
   * way (e.g. `Azure.Functions.Function` with `app`, or CI).
   */
  main?: string;
  /**
   * Named export of `main` that holds the program or handler.
   * @default "default"
   */
  handler?: string;
  /** Rolldown overrides for the bundle. */
  build?: Bundle.BundleConfig;
  /**
   * Environment variables (app settings) for the program. Accepts literals,
   * `Config` values, Outputs, and resources (a resource arrives as its
   * attributes, JSON-encoded). Merged after the `env` that bindings
   * contribute and before `appSettings`.
   *
   * On an async function app, `Azure.InferEnv` types the handler's `env`
   * argument from this object.
   */
  env?: Env;
}

/** Attributes of `Azure.Web.FunctionApp`. */
export interface FunctionAppAttributes extends SiteAttributes {
  /** Hash of the deployed package, when Alchemy deploys `main`. */
  codeHash: string | undefined;
  /** Event Grid subscriptions the app's event sources created. */
  eventSubscriptions: { scope: string; name: string }[];
}

export interface FunctionApp<
  Env extends Record<string, any> = Record<string, any>,
> extends Resource<
  FunctionAppTypeId,
  FunctionAppProps<Env>,
  FunctionAppAttributes,
  FunctionBinding,
  Providers
> {}

/**
 * Services a function app's program may require: credentials, and
 * `Azure.Functions.Function`, the host the Functions timers and event
 * sources resolve (the function app itself serves it).
 */
export type FunctionAppServices = Credentials | Function;
export type FunctionAppShape = Main<FunctionAppServices>;

/** Runtime context of a function app: `serve` for `fetch`, `trigger` for event sources. */
export type FunctionAppRuntimeContext = FunctionRuntimeContext;

/**
 * Serves the app as `Azure.Functions.Function`, the host
 * `Azure.Functions.schedule` and the `Azure.Functions.*EventSource` layers
 * resolve. They read only `LogicalId`, `bind`, `trigger`, and
 * `principalId`, which a function app has with the same shapes.
 */
const FunctionsTriggerHost = Layer.effect(
  Self<Function>(FunctionTypeId),
  Effect.gen(function* () {
    const app = yield* Self<FunctionApp>(FunctionAppTypeId);
    // TS cannot relate two resource interfaces that share only these members.
    return app as unknown as Function;
  }),
);

const createFunctionAppRuntimeContext = (id: string): FunctionAppRuntimeContext => ({
  ...makeFunctionsRuntimeContext(FunctionAppTypeId)(id),
  hostServices: FunctionsTriggerHost,
});

const transformFunctionAppProps = (_id: string, props: FunctionAppProps) =>
  Effect.gen(function* () {
    // Inside the bundle props are final.
    if (globalThis.__ALCHEMY_RUNTIME__ || props.resourceGroup !== undefined) return props;
    const { name } = yield* stackResourceGroup;
    return { ...props, resourceGroup: name };
  });

/**
 * An Azure Functions app (`Microsoft.Web/sites`, kind `functionapp`) on an
 * App Service plan you choose: Flex Consumption (`FC1`), Elastic Premium
 * (`EP1`-`EP3`), a dedicated plan (`B1`, `S1`, `P1v3`, …), or Windows
 * Consumption (`Y1`).
 *
 * Use it two ways. Pass `main` and Alchemy bundles your Node.js program,
 * deploys it with Kudu OneDeploy, and runs it as the app's system-assigned
 * managed identity, so bindings and event sources reach Azure without
 * secrets. Omit `main` and the resource manages only the app's
 * configuration, for any language.
 *
 * On every deploy Alchemy syncs the site properties, the site
 * configuration, the app settings (replaced with exactly the desired map),
 * the managed identity, its role assignments, and tags against the live
 * app. For a Flex Consumption app on a plan Alchemy creates for you, use
 * `Azure.Functions.Function` instead.
 *
 * :::caution[Changing `name`, `resourceGroup`, `location`, `os`, or the deployment container replaces the app]
 * A new app is created and the old one is deleted. On Flex Consumption the
 * old app is deleted first: an `FC1` plan hosts one app.
 * :::
 *
 * :::caution[Linux Consumption cannot take `main`]
 * Linux apps on a `Y1` plan have no Kudu endpoint, so Alchemy cannot
 * deploy a package to them (`Azure.Web.FunctionAppDeployUnsupported`). Use
 * Flex Consumption.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-functions/functions-overview
 *
 * ### Effect Function Apps
 * A function app is a class. Props describe the app, and the Effect is the
 * program. `main: import.meta.url` makes the file both the bundle entry and
 * the program. Init binds resources and registers timers and event
 * sources; the returned `fetch` serves every HTTP request through one
 * catch-all function.
 *
 * **Example:** Effect function app on a Flex Consumption plan
 * ```typescript
 * // src/api.ts
 * import * as Azure from "@alchemy.run/azure";
 * import * as Output from "alchemy/Output";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Plan = Azure.Web.AppServicePlan("ApiPlan", { sku: "FC1" });
 * export const Storage = Azure.Storage.StorageAccount("ApiStorage");
 * export const Releases = Effect.gen(function* () {
 *   const account = yield* Storage;
 *   return yield* Azure.Storage.BlobContainer("ApiReleases", {
 *     storageAccount: account.storageAccountName,
 *   });
 * });
 *
 * export default class Api extends Azure.Web.FunctionApp<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const plan = yield* Plan;
 *     const account = yield* Storage;
 *     const releases = yield* Releases;
 *     return {
 *       main: import.meta.url,
 *       serverFarmId: plan.appServicePlanId,
 *       hostStorageAccountId: account.storageAccountId,
 *       flexConsumption: {
 *         deploymentStorageUrl: Output.interpolate`${account.primaryEndpoints.blob}${releases.containerName}`,
 *         deploymentStorageAuthentication: { type: "SystemAssignedIdentity" },
 *       },
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello from Azure")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * **Example:** Deploying it from the stack
 * ```typescript
 * // alchemy.run.ts
 * import Api from "./src/api.ts";
 *
 * export default Alchemy.Stack(
 *   "MyApp",
 *   { providers: Azure.providers(), state: Alchemy.localState() },
 *   Effect.gen(function* () {
 *     const api = yield* Api;
 *     return { url: api.url };
 *   }),
 * );
 * ```
 *
 * ### Async Function Apps
 * You don't have to use Effect. Call `FunctionApp` with `main` pointing at
 * a plain handler file and no implementation. Alchemy bundles that file
 * as-is. The `env` prop takes literals, `Config` values, and resources,
 * and `Azure.InferEnv` types the handler's `env` argument.
 *
 * **Example:** Declaring an async function app on a dedicated plan
 * ```typescript
 * // alchemy.run.ts
 * const plan = yield* Azure.Web.AppServicePlan("Plan", { sku: "B1" });
 * export const Hello = Azure.Web.FunctionApp("Hello", {
 *   main: "./src/hello.ts",
 *   serverFarmId: plan.appServicePlanId,
 *   hostStorageAccountId: account.storageAccountId,
 *   env: {
 *     GREETING: "hello",
 *     API_KEY: Config.redacted("API_KEY"),
 *     UPLOADS: uploads,
 *   },
 * });
 * export type HelloEnv = Azure.InferEnv<typeof Hello>;
 * ```
 *
 * **Example:** Writing the async handler
 * ```typescript
 * // src/hello.ts
 * import type { HelloEnv } from "../alchemy.run.ts";
 *
 * export default {
 *   async fetch(request: Request, env: HelloEnv) {
 *     const name = new URL(request.url).searchParams.get("name") ?? "world";
 *     return new Response(`${env.GREETING} ${name} (${env.UPLOADS.containerName})`);
 *   },
 * };
 * ```
 *
 * ### Hosting Plans
 * Without `main` the app runs whatever you deploy to it, in any language.
 *
 * **Example:** Python function app on Elastic Premium
 * ```typescript
 * const plan = yield* Azure.Web.AppServicePlan("functions", { sku: "EP1" });
 * const app = yield* Azure.Web.FunctionApp("api", {
 *   serverFarmId: plan.appServicePlanId,
 *   runtime: { name: "python" },
 *   siteConfig: { linuxFxVersion: "Python|3.12" },
 *   hostStorageAccountId: account.storageAccountId,
 * });
 * ```
 *
 * **Example:** Flex Consumption app with a connection string
 * ```typescript
 * const app = yield* Azure.Web.FunctionApp("api", {
 *   serverFarmId: plan.appServicePlanId,
 *   runtime: { name: "node", version: "22" },
 *   flexConsumption: {
 *     deploymentStorageUrl: Output.interpolate`${account.primaryEndpoints.blob}${container.containerName}`,
 *     deploymentStorageAuthentication: {
 *       type: "StorageAccountConnectionString",
 *       storageAccountConnectionStringName: "AzureWebJobsStorage",
 *     },
 *     maximumInstanceCount: 40,
 *     instanceMemoryMB: 2048,
 *   },
 *   appSettings: { AzureWebJobsStorage: connectionString },
 * });
 * ```
 *
 * **Example:** Windows PowerShell function app
 * ```typescript
 * const plan = yield* Azure.Web.AppServicePlan("functions", { sku: "Y1", os: "windows" });
 * const app = yield* Azure.Web.FunctionApp("scripts", {
 *   serverFarmId: plan.appServicePlanId,
 *   os: "windows",
 *   runtime: { name: "powershell" },
 *   siteConfig: { powerShellVersion: "7.4" },
 *   appSettings: { AzureWebJobsStorage: connectionString },
 * });
 * ```
 *
 * ### Configuration
 * **Example:** Name, settings, identity, and tags
 * ```typescript
 * export default class Api extends Azure.Web.FunctionApp<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const plan = yield* Plan;
 *     return {
 *       main: import.meta.url,
 *       name: "contoso-api",
 *       serverFarmId: plan.appServicePlanId,
 *       siteConfig: { http20Enabled: true, minTlsVersion: "1.2" },
 *       env: { LOG_LEVEL: "info" },
 *       identity: { type: "UserAssigned", userAssignedIdentityIds: [identity.identityId] },
 *       tags: { team: "web" },
 *     };
 *   }),
 *   program,
 * ) {}
 * ```
 *
 * ### Bindings
 * Bindings grant the app's managed identity the smallest data role on the
 * bound resource and hand the program a typed client. The app runs as its
 * system-assigned identity, so no secret is stored.
 *
 * **Example:** Read and write blobs
 * ```typescript
 * Effect.gen(function* () {
 *   const files = yield* Azure.Storage.BlobContainerReadWrite(uploads);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       yield* files.put("hello.txt", "hi");
 *       const blob = yield* files.get("hello.txt");
 *       return HttpServerResponse.text(blob?.text() ?? "missing");
 *     }).pipe(Effect.orDie),
 *   };
 * }).pipe(Effect.provide(Azure.Storage.BlobContainerReadWriteHttp))
 * ```
 *
 * **Example:** Read a Key Vault secret
 * ```typescript
 * const apiKey = yield* Azure.KeyVault.SecretRead(apiKeySecret);
 * // runtime: the latest version, as a Redacted<string>
 * const value = yield* apiKey.get();
 * ```
 *
 * ### Timers
 * **Example:** Run on a schedule
 * ```typescript
 * yield* Azure.Functions.schedule("nightly", "0 0 3 * * *", () =>
 *   Effect.log("nightly job"),
 * );
 * ```
 *
 * ### Event Sources
 * A function app takes the same event sources as `Azure.Functions.Function`:
 * provide the `Azure.Functions.*EventSource` layers. Each registers a
 * native trigger function with an identity-based connection and grants the
 * role it needs.
 *
 * **Example:** Consume a Storage queue
 * ```typescript
 * yield* Azure.Storage.consumeQueueMessages(jobs, (message) =>
 *   Effect.log(message.body),
 * );
 * // …provided with Effect.provide(Azure.Functions.StorageQueueEventSource)
 * ```
 *
 * **Example:** React to new blobs
 * ```typescript
 * yield* Azure.Storage.consumeBlobCreated(uploads, { prefix: "in/" }, (event) =>
 *   Effect.log(`uploaded ${event.blobName}`),
 * );
 * // …provided with Effect.provide(Azure.Functions.BlobCreatedEventSource)
 * ```
 *
 * **Example:** Consume a Service Bus queue or an event hub
 * ```typescript
 * yield* Azure.ServiceBus.consumeQueueMessages(orders, (message) =>
 *   Effect.log(message.body),
 * );
 * yield* Azure.EventHub.consumeEvents(hub, (batch) =>
 *   Effect.log(`${batch.events.length} events`),
 * );
 * // …provided with Azure.Functions.ServiceBusQueueEventSource and
 * // Azure.Functions.EventHubEventSource
 * ```
 *
 * @resource
 * @category Web
 */
export const FunctionApp: Platform<
  FunctionApp,
  FunctionAppServices,
  FunctionAppShape,
  FunctionAppRuntimeContext,
  {},
  FunctionAppProps
> & {
  /**
   * Async (no-impl) constructor: captures the `env` literal so
   * `Azure.InferEnv` types the handler's `env` argument.
   */
  <const Env extends Record<string, any>, PropsReq = never>(
    id: string,
    props:
      | InputProps<FunctionAppProps<Env>>
      | Effect.Effect<InputProps<FunctionAppProps<Env>>, never, PropsReq>,
  ): Effect.Effect<FunctionApp<Env>, never, Providers | PropsReq>;
} = Platform(FunctionAppTypeId, {
  createRuntimeContext: createFunctionAppRuntimeContext,
  transformProps: (id, props) => transformFunctionAppProps(id, props),
});

export class FunctionAppResourceGroupMissing extends Data.TaggedError(
  "Azure.Web.FunctionAppResourceGroupMissing",
)<{ message: string }> {}

export class FunctionAppDeployUnsupported extends Data.TaggedError(
  "Azure.Web.FunctionAppDeployUnsupported",
)<{ siteName: string; message: string }> {}

export class FunctionAppIdentityMissing extends Data.TaggedError(
  "Azure.Web.FunctionAppIdentityMissing",
)<{ siteName: string; message: string }> {}

/** Node.js major version Alchemy runs `main` on. */
const NODE_VERSION = "22";

/** Props once `transformProps` has filled in the resource group. */
type GroupedProps = FunctionAppProps & { resourceGroup: string };

const grouped = (props: FunctionAppProps): GroupedProps | undefined => {
  const { resourceGroup } = props;
  return resourceGroup === undefined ? undefined : { ...props, resourceGroup };
};

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
  runtime: runtime ? { name: runtime.name, version: runtime.version } : undefined,
  // Flex Consumption requires both scale settings on every PUT.
  scaleAndConcurrency: {
    maximumInstanceCount: flex.maximumInstanceCount ?? 100,
    instanceMemoryMB: flex.instanceMemoryMB ?? 2048,
  },
});

const lifecycle = makeSiteLifecycle<GroupedProps>({
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
          ...(props.runtime ? { FUNCTIONS_WORKER_RUNTIME: props.runtime.name } : {}),
        },
  putOnlyProperties: (props) =>
    props.flexConsumption
      ? {
          functionAppConfig: functionAppConfig(props.flexConsumption, props.runtime),
        }
      : {},
  replaces: (news, olds) =>
    olds !== undefined &&
    ((news.flexConsumption === undefined) !== (olds.flexConsumption === undefined) ||
      lower(news.flexConsumption?.deploymentStorageUrl) !==
        lower(olds.flexConsumption?.deploymentStorageUrl)),
  // A Flex Consumption plan hosts exactly one app, so a replacement on the
  // same plan must delete the old app first.
  deleteFirst: (news, output) =>
    news.flexConsumption !== undefined && lower(news.serverFarmId) === lower(output.serverFarmId),
});

/** Add the system-assigned identity the program, bindings, and host storage use. */
const withSystemIdentity = (identity: SiteIdentity | undefined): SiteIdentity =>
  identity === undefined || identity.type !== "UserAssigned"
    ? { ...identity, type: identity?.type ?? "SystemAssigned" }
    : { ...identity, type: "SystemAssigned, UserAssigned" };

/** Plan tiers that run dedicated workers, where Always On keeps the host loaded. */
const DEDICATED_TIER = /^(basic|standard|premium|isolated)/i;

/**
 * The props the site lifecycle applies when Alchemy deploys `main`: a
 * Node.js runtime on the plan's mechanism (Flex `functionAppConfig`, Linux
 * `linuxFxVersion`, or the Windows Node version setting). Outside Flex
 * Consumption the app runs from the package Kudu stores
 * (`WEBSITE_RUN_FROM_PACKAGE=1`), and dedicated plans keep the host loaded
 * so timers and queue triggers fire (`alwaysOn`).
 */
const withNodeRuntime = (props: GroupedProps, planTier: string | undefined): GroupedProps => {
  const runtime = props.runtime ?? { name: "node" as const, version: NODE_VERSION };
  if (props.flexConsumption !== undefined) return { ...props, runtime };
  const version = runtime.version ?? NODE_VERSION;
  const linux = (props.os ?? "linux") === "linux";
  return {
    ...props,
    runtime,
    siteConfig: {
      ...(linux ? { linuxFxVersion: `Node|${version}` } : {}),
      ...(planTier !== undefined && DEDICATED_TIER.test(planTier) ? { alwaysOn: true } : {}),
      ...props.siteConfig,
    },
    appSettings: {
      WEBSITE_RUN_FROM_PACKAGE: "1",
      ...(linux ? {} : { WEBSITE_NODE_DEFAULT_VERSION: `~${version}` }),
      ...props.appSettings,
    },
  };
};

/** SKU tier of the app's plan, e.g. `Dynamic`, `ElasticPremium`, `Standard`. */
const planTierOf = Effect.fn(function* (subscriptionId: string, serverFarmId: string) {
  const resourceGroupName = resourceGroupOf(serverFarmId);
  const name = nameOf(serverFarmId);
  if (resourceGroupName === undefined || name === undefined) return undefined;
  const plan = yield* orUndefinedIfNotFound(
    web.GetAppServicePlan({ subscriptionId, resourceGroupName, name }),
  );
  return plan?.sku?.tier;
});

export const FunctionAppProvider = () =>
  Provider.effect(
    FunctionApp,
    Effect.gen(function* () {
      const bundle = yield* makeBundler;

      return FunctionApp.Provider.of({
        stables: lifecycle.stables,
        nuke: {
          dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Web.AppServicePlan"],
        },

        list: Effect.fn(function* () {
          const sites = yield* lifecycle.list();
          return sites.map((site): FunctionAppAttributes => ({
            ...site,
            codeHash: undefined,
            eventSubscriptions: [],
          }));
        }),

        diff: Effect.fn(function* ({ news, olds, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          const props = grouped(news as FunctionAppProps);
          if (props === undefined) return undefined;
          const replace = yield* lifecycle.diff({
            news: props,
            // Without old props no Flex change can be detected.
            olds: (olds === undefined ? undefined : grouped(olds)) ?? props,
            output,
          });
          if (replace !== undefined) return replace;
          if (props.main === undefined) return undefined;
          // A code-only change leaves the props untouched: compare bundles.
          const { codeHash } = yield* bundle({ ...props, main: props.main });
          return codeHash !== output.codeHash ? ({ action: "update" } as const) : undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const attrs = yield* lifecycle.read({
            id,
            olds: olds === undefined ? undefined : grouped(olds),
            output,
          });
          if (attrs === undefined) return undefined;
          const full: FunctionAppAttributes = {
            ...attrs,
            codeHash: output?.codeHash,
            eventSubscriptions: output?.eventSubscriptions ?? [],
          };
          return Unowned.is(attrs) ? Unowned(full) : full;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
          const { subscriptionId } = yield* AzureEnvironment.current;
          const props = grouped(news);
          if (props === undefined) {
            return yield* new FunctionAppResourceGroupMissing({
              message: `Azure.Web.FunctionApp "${id}" has no resource group`,
            });
          }
          const collected = collectBindings(bindings as ResourceBinding<FunctionBinding>[]);
          const { main } = props;
          if (main !== undefined && props.runtime !== undefined && props.runtime.name !== "node") {
            return yield* new FunctionAppDeployUnsupported({
              siteName: props.name ?? id,
              message: `Azure.Web.FunctionApp "${id}" deploys "main" on Node.js only (runtime is "${props.runtime.name}")`,
            });
          }
          const planTier =
            main !== undefined && props.flexConsumption === undefined
              ? yield* planTierOf(subscriptionId, props.serverFarmId)
              : undefined;
          // Linux Consumption (`Y1`, tier `Dynamic`) has no Kudu endpoint.
          if ((props.os ?? "linux") === "linux" && planTier?.toLowerCase() === "dynamic") {
            return yield* new FunctionAppDeployUnsupported({
              siteName: props.name ?? id,
              message: `Azure.Web.FunctionApp "${id}" is on a Linux Consumption plan, which has no Kudu endpoint to deploy "main" to; use Flex Consumption`,
            });
          }
          const hostStorage = props.hostStorageAccountId;
          const grants = [
            ...(hostStorage === undefined
              ? []
              : HOST_STORAGE_ROLES.map((roleDefinitionId) => ({
                  roleDefinitionId,
                  scope: hostStorage,
                }))),
            ...collected.grants,
          ];
          const needsIdentity = main !== undefined || grants.length > 0;

          // Desired app settings: host storage, the runtime's stack identity,
          // binding env, the program's env, then the user's raw settings.
          const appSettings: Record<string, string> = {};
          const hostStorageName = nameOf(hostStorage);
          if (hostStorageName !== undefined) {
            appSettings.AzureWebJobsStorage__accountName = hostStorageName;
          }
          if (main !== undefined) {
            const stack = yield* Stack;
            appSettings.ALCHEMY_STACK_NAME = stack.name;
            appSettings.ALCHEMY_STAGE = stack.stage;
            appSettings.ALCHEMY_PHASE = "runtime";
          }
          for (const [key, value] of Object.entries({ ...collected.env, ...props.env })) {
            if (value !== undefined) appSettings[key] = envString(value);
          }
          Object.assign(appSettings, props.appSettings);

          const desired: GroupedProps = {
            ...props,
            identity: needsIdentity ? withSystemIdentity(props.identity) : props.identity,
            appSettings,
          };

          // Observe, ensure, and sync the site, its config, settings, and identity.
          const site = yield* lifecycle.reconcile({
            id,
            news: main !== undefined ? withNodeRuntime(desired, planTier) : desired,
            output,
          });
          const where = {
            subscriptionId,
            resourceGroupName: site.resourceGroup,
            name: site.siteName,
          };

          // Grant host-storage and binding roles; revoke the ones no longer asked for.
          if (site.principalId !== undefined) {
            yield* syncBindingAssignments({
              id,
              subscriptionId,
              appId: site.siteId,
              principalId: site.principalId,
              grants,
            });
          } else if (grants.length > 0) {
            return yield* new FunctionAppIdentityMissing({
              siteName: site.siteName,
              message: `function app ${site.siteName} needs a system-assigned identity for its role assignments`,
            });
          }

          // Deploy when the package changed (or the app is new).
          let codeHash: string | undefined;
          if (main !== undefined) {
            const built = yield* bundle({ ...props, main });
            codeHash = built.codeHash;
            if (output?.codeHash !== codeHash || output.siteName !== site.siteName) {
              const archive = yield* zipFiles(built.files);
              const observed = yield* getSite(subscriptionId, site.resourceGroup, site.siteName);
              yield* deployPackage({
                functionAppName: site.siteName,
                scmHostName: scmHostOf(observed ?? {}, site.defaultHostName),
                archive: new Uint8Array(archive),
                // Flex Consumption's OneDeploy takes the package as-is.
                artifactType: props.flexConsumption === undefined ? "zip" : undefined,
              });
            }
          }

          // Event Grid validates an `AzureFunction` destination against the
          // host, so wait until the deployed code's functions are indexed.
          if (collected.eventSubscriptions.length > 0) {
            yield* waitForFunctions(
              where,
              collected.eventSubscriptions.map((s) => s.functionName),
            );
          }
          const eventSubscriptions = yield* syncEventSubscriptions({
            subscriptionId,
            siteId: site.siteId,
            desired: collected.eventSubscriptions,
            previous: output?.eventSubscriptions ?? [],
          });

          return { ...site, codeHash, eventSubscriptions };
        }),

        delete: Effect.fn(function* ({ id, output }) {
          const { subscriptionId } = yield* AzureEnvironment.current;
          yield* syncEventSubscriptions({
            subscriptionId,
            siteId: output.siteId,
            desired: [],
            previous: output.eventSubscriptions ?? [],
          });
          // Role assignments outlive their principal; revoke them first.
          const observed = yield* getSite(subscriptionId, output.resourceGroup, output.siteName);
          const principalId = observed?.identity?.principalId ?? output.principalId;
          if (principalId !== undefined) {
            yield* syncBindingAssignments({
              id,
              subscriptionId,
              appId: observed?.id ?? output.siteId,
              principalId,
              grants: [],
            });
          }
          yield* lifecycle.delete({ output });
        }),
      });
    }),
  );
