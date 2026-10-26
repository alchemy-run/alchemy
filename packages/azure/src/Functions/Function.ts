import type { Credentials } from "@distilled.cloud/azure";
import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import * as web from "@distilled.cloud/azure/web";
import { Unowned } from "alchemy/AdoptPolicy";
import type * as Bundle from "alchemy/Bundle/Bundle";
import { isResolved } from "alchemy/Diff";
import type { InputProps } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import { createPhysicalName } from "alchemy/PhysicalName";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import { Resource, type ResourceBinding } from "alchemy/Resource";
import type { BaseRuntimeContext } from "alchemy/RuntimeContext";
import { Stack } from "alchemy/Stack";
import { zipFiles } from "alchemy/Util/zip";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { syncBindingAssignments } from "../ContainerApps/ContainerApp.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { runsLocal, stackResourceGroup, stackResourceGroupName } from "../StackResourceGroup.ts";
import { BlobContainer } from "../Storage/BlobContainer.ts";
import { StorageAccount } from "../Storage/StorageAccount.ts";
import { AppServicePlan } from "../Web/AppServicePlan.ts";
import { getSite } from "../Web/Site.ts";
import {
  collectBindings,
  deployPackage,
  envString,
  HOST_STORAGE_ROLES,
  makeBundler,
  makeFunctionsRuntimeContext,
  sameName,
  scmHostOf,
  syncEventSubscriptions,
  waitForFunctions,
} from "./host/internal.ts";
import type { TriggerBinding, TriggerInvocation } from "./internal.ts";

export type { InferEnv } from "../InferEnv.ts";
export type { TriggerBinding, TriggerInvocation } from "./internal.ts";
export { FunctionDeployFailed, FunctionsNotIndexed } from "./host/internal.ts";

export const FunctionTypeId = "Azure.Functions.Function" as const;
export type FunctionTypeId = typeof FunctionTypeId;

/** A role the function app's managed identity holds on one scope. */
export interface FunctionRoleAssignment {
  /** Built-in role GUID or full role-definition ARM ID. */
  roleDefinitionId: string;
  /** ARM ID the role is granted on: the bound resource, never wider. */
  scope: string;
}

/**
 * An Event Grid subscription that delivers events from `scope` to one of the
 * app's `eventGridTrigger` functions.
 */
export interface FunctionEventSubscription {
  /** Subscription name, unique on `scope` (3-64 letters, digits, hyphens). */
  name: string;
  /** ARM ID of the event source (a storage account, a topic, …). */
  scope: string;
  /** Name of the `eventGridTrigger` function that receives the events. */
  functionName: string;
  /** Event types to deliver, e.g. `Microsoft.Storage.BlobCreated`. */
  includedEventTypes?: string[];
  /** Subject prefix filter. */
  subjectBeginsWith?: string;
  /** Subject suffix filter. */
  subjectEndsWith?: string;
}

/**
 * Binding contract accepted by `Azure.Functions.Function` (the Azure
 * `HostBinding` shape plus Event Grid subscriptions):
 *
 * - `roleAssignments` are granted to the app's system-assigned identity;
 *   the ones a deploy no longer asks for are revoked (only ones it made).
 * - `env` becomes app settings.
 * - `eventSubscriptions` are created once the code is deployed.
 */
export interface FunctionBinding {
  roleAssignments?: FunctionRoleAssignment[];
  env?: Record<string, unknown>;
  eventSubscriptions?: FunctionEventSubscription[];
}

/** An existing function app to deploy into instead of creating one. */
export interface FunctionAppRef {
  /** Name of the function app (`Azure.Web.FunctionApp`'s `siteName`). */
  siteName: string;
  /** Resource group of the function app. */
  resourceGroup: string;
}

/**
 * The compute Alchemy creates for a Function. Set automatically.
 * @internal
 */
export interface FunctionHosting {
  serverFarmId: string;
  storageAccountName: string;
  storageAccountId: string;
  blobEndpoint: string;
  deploymentContainer: string;
}

export interface FunctionProps<
  Env extends Record<string, any> = Record<string, any>,
> extends PlatformProps {
  /**
   * Entry module. For an Effect Function this is `import.meta.url` (the
   * file is both the bundle entry and the program). For an async Function
   * it is a handler file that default-exports `{ fetch(request, env) }`.
   * Alchemy bundles it for Node.js 22 into one ESM file.
   */
  main: string;
  /**
   * Named export of `main` that holds the program or handler.
   * @default "default"
   */
  handler?: string;
  /** Rolldown overrides for the bundle. */
  build?: Bundle.BundleConfig;
  /**
   * Name of the function app (the `{name}.azurewebsites.net` label): 2-60
   * letters, digits, and hyphens. Changing it replaces the Function.
   * @default a unique name from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Resource group of the function app and its plan and storage. Changing
   * it replaces the Function.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup?: string;
  /**
   * Azure location. Must offer Flex Consumption. Changing it replaces the
   * Function.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Deploy into an existing function app instead of creating one. The app
   * must run on Linux with `runtime: { name: "node" }` and a
   * system-assigned identity; Alchemy then owns only its code and the app
   * settings it writes. Changing it replaces the Function.
   */
  app?: FunctionAppRef;
  /**
   * Environment variables (app settings). Accepts literals, `Config`
   * values, Outputs, and resources (a resource arrives as its attributes,
   * JSON-encoded). Merged after the `env` that bindings contribute.
   *
   * On an async Function, {@link InferEnv} types the handler's `env`
   * argument from this object.
   */
  env?: Env;
  /**
   * Memory per instance in MB: `512`, `2048`, or `4096`. CPU scales with it.
   * @default 2048
   */
  instanceMemoryMB?: 512 | 2048 | 4096;
  /**
   * Maximum number of instances the app scales out to (40-1000).
   * @default 100
   */
  maximumInstanceCount?: number;
  /**
   * User tags on the function app. Alchemy ownership tags are merged in.
   */
  tags?: Record<string, string>;
  /** @internal Set automatically by Alchemy. */
  hosting?: FunctionHosting;
  /** @internal Extra host.json `extensions` (set by `WorkflowFunction`). */
  hostExtensions?: Record<string, unknown>;
}

export interface FunctionAttributes {
  /** Name of the function app. */
  functionAppName: string;
  /** ARM resource ID of the function app; use it as a role-assignment scope. */
  functionAppId: string;
  /** Resource group of the function app. */
  resourceGroup: string;
  /** Location of the function app. */
  location: string;
  /** Default host name, e.g. `my-app.azurewebsites.net`. */
  defaultHostName: string;
  /** Public HTTPS URL of the app. */
  url: string;
  /** Object ID of the app's system-assigned managed identity. */
  principalId: string | undefined;
  /** Storage account the app's host and deployments use (Alchemy-created apps). */
  storageAccountName: string | undefined;
  /** Whether Alchemy created (and deletes) the function app. */
  managedApp: boolean;
  /** Hash of the deployed package. */
  codeHash: string;
  /** App-setting keys this resource wrote. */
  settingKeys: string[];
  /** Event Grid subscriptions this resource created. */
  eventSubscriptions: { scope: string; name: string }[];
}

export interface Function<Env extends Record<string, any> = Record<string, any>> extends Resource<
  FunctionTypeId,
  FunctionProps<Env>,
  FunctionAttributes,
  FunctionBinding,
  Providers
> {}

export type FunctionServices = Credentials;
export type FunctionShape = Main<FunctionServices>;

/**
 * A trigger handler: one invocation, one Effect. A defect fails the
 * invocation. A durable trigger's value is its return value.
 */
export type TriggerHandler = (invocation: TriggerInvocation) => Effect.Effect<unknown, never, any>;

/** Runtime context of an Azure Functions host. */
export interface FunctionRuntimeContext extends BaseRuntimeContext {
  /**
   * Register a native trigger function `name` (e.g. a `queueTrigger`)
   * handled by `handler`. A no-op at deploy time; at runtime the bootstrap
   * registers it with the Functions worker. Event sources call this.
   */
  trigger: (name: string, binding: TriggerBinding, handler: TriggerHandler) => Effect.Effect<void>;
}

const transformFunctionProps = (id: string, props: FunctionProps) =>
  Effect.gen(function* () {
    // Composition is a deploy concern; inside the bundle props are final.
    if (globalThis.__ALCHEMY_RUNTIME__) return props;
    if (props.app !== undefined) return props;
    // Under `alchemy dev` the program runs locally: no plan, storage, or group.
    if (yield* runsLocal) {
      return { ...props, resourceGroup: props.resourceGroup ?? (yield* stackResourceGroupName) };
    }
    const resourceGroup = props.resourceGroup ?? (yield* stackResourceGroup).name;
    const hosting = yield* Effect.gen(function* () {
      const plan = yield* AppServicePlan("Plan", {
        resourceGroup,
        location: props.location,
        sku: "FC1",
      });
      const storage = yield* StorageAccount("Storage", {
        resourceGroup,
        location: props.location,
      });
      const releases = yield* BlobContainer("Releases", {
        resourceGroup,
        storageAccount: storage.storageAccountName,
      });
      return {
        serverFarmId: plan.appServicePlanId,
        storageAccountName: storage.storageAccountName,
        storageAccountId: storage.storageAccountId,
        blobEndpoint: storage.primaryEndpoints.blob,
        deploymentContainer: releases.containerName,
      };
    }).pipe(Namespace.push(id));
    return { ...props, resourceGroup, hosting };
  });

/**
 * An Azure Functions app on the Flex Consumption plan, running a Node.js 22
 * program that Alchemy bundles and deploys. It scales to zero and bills per
 * execution.
 *
 * Alchemy creates the function app (Linux, system-assigned managed
 * identity), its `FC1` plan, a storage account for the Functions host, and
 * the blob container that holds deployment packages. The host reaches its
 * storage with the managed identity (no connection strings). Pass `app` to
 * deploy into an existing function app instead.
 *
 * The program runs on the Functions Node.js worker. One catch-all HTTP
 * function (`route: "{*path}"`, anonymous) forwards every request to
 * `fetch`, and each event source adds a native trigger function.
 *
 * :::caution[Changing `name`, `resourceGroup`, `location`, or `app` replaces the Function]
 * A new function app is created, and the old one, with its plan and
 * storage, is deleted.
 * :::
 *
 * :::caution[Cold starts]
 * An idle app has no instances. The first request after a deploy or an idle
 * period waits for an instance to start (a few seconds).
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-functions/flex-consumption-plan
 *
 * ### Effect Functions
 * A Function is a class. Props describe the function app, and the Effect is
 * the program. `main: import.meta.url` makes the file both the bundle entry
 * and the program. Init binds resources and registers event sources; the
 * returned `fetch` runs per request.
 *
 * **Example:** Effect Function with an HTTP handler
 * ```typescript
 * // src/api.ts
 * import * as Azure from "@alchemy.run/azure";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
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
 * ### Async Functions
 * You don't have to use Effect. Call the Function with `main` pointing at a
 * plain handler file and no implementation. Alchemy bundles that file as-is
 * (no Effect runtime in it). The `env` prop takes literals, `Config` values,
 * and resources, and {@link InferEnv} types the handler's `env` argument.
 *
 * **Example:** Declaring an async Function
 * ```typescript
 * // alchemy.run.ts
 * export const Hello = Azure.Functions.Function("Hello", {
 *   main: "./src/hello.ts",
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
 * ### Configuration
 * **Example:** Name, location, and scale settings
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     name: "contoso-api",
 *     location: "westeurope",
 *     instanceMemoryMB: 4096,
 *     maximumInstanceCount: 40,
 *     tags: { team: "web" },
 *   },
 *   program,
 * ) {}
 * ```
 *
 * **Example:** Deploy into an existing function app
 * ```typescript
 * const app = yield* Azure.Web.FunctionApp("App", {
 *   serverFarmId: plan.appServicePlanId,
 *   runtime: { name: "node", version: "22" },
 *   identity: { type: "SystemAssigned" },
 *   flexConsumption: { deploymentStorageUrl, deploymentStorageAuthentication },
 * });
 * const api = yield* Azure.Functions.Function("Api", {
 *   main: "./src/api.ts",
 *   app: { siteName: app.siteName, resourceGroup: app.resourceGroup },
 * });
 * ```
 *
 * ### Packaging
 * `main` is bundled with Rolldown into `index.mjs` (ESM, Node.js 22) and
 * zip-deployed with Kudu OneDeploy into the app's deployment container. No
 * `node_modules` ship: every dependency is bundled. A deploy runs only when
 * the bundle's hash changes. Pass `build` to tune Rolldown.
 *
 * **Example:** Keep a package out of the bundle
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     build: { input: { external: ["sharp"] } },
 *   },
 *   program,
 * ) {}
 * ```
 *
 * ### Storage Bindings
 * Bindings grant the app's managed identity the smallest data role on the
 * bound resource and hand the program a typed client.
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
 * **Example:** Send to a Storage queue
 * ```typescript
 * // init
 * const send = yield* Azure.Storage.QueueSend(jobs);
 *
 * // runtime
 * yield* send.send(JSON.stringify({ id: 1 }));
 * ```
 *
 * ### Key Vault Bindings
 * **Example:** Read a secret
 * ```typescript
 * // init
 * const apiKey = yield* Azure.KeyVault.SecretRead(apiKeySecret);
 *
 * // runtime: the latest version, as a Redacted<string>
 * const value = yield* apiKey.get();
 * ```
 *
 * ### Service Bus and Event Hubs Bindings
 * **Example:** Send a Service Bus message
 * ```typescript
 * const orders = yield* Azure.ServiceBus.QueueSend(queue);
 * yield* orders.send({ id: 1 }, { messageId: "order-1" });
 * ```
 *
 * **Example:** Send an event to an event hub
 * ```typescript
 * const telemetry = yield* Azure.EventHub.Send(hub);
 * yield* telemetry.send({ temperature: 21 });
 * yield* telemetry.sendBatch([{ temperature: 21 }, { temperature: 22 }]);
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
 * Each event source registers a native trigger function, sets its
 * identity-based connection settings, and grants the role it needs. The
 * contract lives in the source's service; provide the Functions layer.
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
 * yield* Azure.Storage.consumeBlobCreated(uploads, (event) =>
 *   Effect.log(`uploaded ${event.blobName}`),
 * );
 * // …provided with Effect.provide(Azure.Functions.BlobCreatedEventSource)
 * ```
 *
 * **Example:** Consume a Service Bus queue or topic subscription
 * ```typescript
 * yield* Azure.ServiceBus.consumeQueueMessages(orders, (message) =>
 *   Effect.log(message.body),
 * );
 * yield* Azure.ServiceBus.consumeSubscriptionMessages(audit, (message) =>
 *   Effect.log(message.body),
 * );
 * // …provided with Azure.Functions.ServiceBusQueueEventSource and
 * // Azure.Functions.ServiceBusSubscriptionEventSource
 * ```
 *
 * **Example:** Consume an event hub
 * ```typescript
 * yield* Azure.EventHub.consumeEvents(hub, (batch) =>
 *   Effect.log(`${batch.events.length} events`),
 * );
 * // …provided with Effect.provide(Azure.Functions.EventHubEventSource)
 * ```
 *
 * **Example:** Subscribe to Event Grid events
 * ```typescript
 * yield* Azure.EventGrid.consumeEvents(
 *   "AccountEvents",
 *   { scope: account.storageAccountId, includedEventTypes: ["Microsoft.Storage.BlobDeleted"] },
 *   (event) => Effect.log(event.subject),
 * );
 * // …provided with Effect.provide(Azure.Functions.EventGridEventSource)
 * ```
 *
 * **Example:** Consume a Cosmos DB change feed
 * ```typescript
 * yield* Azure.CosmosDB.consumeChangeFeed(orders, { leases }, (documents) =>
 *   Effect.log(`${documents.length} changed`),
 * );
 * // …provided with Effect.provide(Azure.Functions.CosmosDBChangeFeedEventSource)
 * ```
 *
 * ### Local Development
 * Under `alchemy dev` the Function runs on your machine: Alchemy bundles it
 * and runs `node` on `http://localhost:<port>`, with the same app settings
 * and no Azure resources. A code change restarts it on the same URL.
 * `Azure.Storage.StorageAccount`, `BlobContainer`, and `Queue` run on
 * [Azurite](https://github.com/Azure/Azurite) in Docker, and the Storage
 * bindings and the Storage queue and timer triggers work against it. Other
 * triggers do not run locally. Pipe the Function through `Alchemy.remote()`
 * to deploy it to Azure during dev.
 *
 * **Example:** One program for `alchemy dev` and `alchemy deploy`
 * ```typescript
 * // alchemy dev → http://localhost:<port>, Storage on Azurite
 * // alchemy deploy → https://<app>.azurewebsites.net, Azure Storage
 * const api = yield* Api;
 * const uploads = yield* Azure.Storage.BlobContainer("Uploads", {
 *   storageAccount: account.storageAccountName,
 * });
 * ```
 *
 * **Example:** Keep the Function in Azure during dev
 * ```typescript
 * const api = yield* Effect.gen(function* () {
 *   return yield* Api;
 * }).pipe(Alchemy.remote());
 * ```
 *
 * @resource
 * @category Functions
 */
export const Function: Platform<
  Function,
  FunctionServices,
  FunctionShape,
  FunctionRuntimeContext,
  {},
  FunctionProps
> & {
  /**
   * Async (no-impl) constructor: captures the `env` literal so
   * {@link InferEnv} types the handler's `env` argument.
   */
  <const Env extends Record<string, any>, PropsReq = never>(
    id: string,
    props:
      | InputProps<FunctionProps<Env>>
      | Effect.Effect<InputProps<FunctionProps<Env>>, never, PropsReq>,
  ): Effect.Effect<Function<Env>, never, Providers | PropsReq>;
} = Platform(FunctionTypeId, {
  createRuntimeContext: makeFunctionsRuntimeContext(FunctionTypeId),
  transformProps: (id, props) => transformFunctionProps(id, props),
});

export class FunctionAppNotFound extends Data.TaggedError("Azure.Functions.FunctionAppNotFound")<{
  functionAppName: string;
  message: string;
}> {}

export class FunctionHostingMissing extends Data.TaggedError(
  "Azure.Functions.FunctionHostingMissing",
)<{ message: string }> {}

export class FunctionIdentityMissing extends Data.TaggedError(
  "Azure.Functions.FunctionIdentityMissing",
)<{ functionAppName: string; message: string }> {}

/** Marks function apps this resource type created (vs `Azure.Web.FunctionApp`). */
const RUNTIME_TAG = "alchemy::runtime";

const createAppName = (id: string) => createPhysicalName({ id, maxLength: 40, lowercase: true });

type ObservedSite = web.GetWebAppResponse;

const siteState = (site: ObservedSite) => {
  const state = site.properties?.state;
  return state === undefined || state === "Running" || state === "Stopped"
    ? undefined
    : "InProgress";
};

const toAttrs = (
  site: ObservedSite,
  extras: {
    resourceGroup: string;
    name: string;
    managedApp: boolean;
    storageAccountName: string | undefined;
    codeHash: string;
    settingKeys: string[];
    eventSubscriptions: { scope: string; name: string }[];
  },
): FunctionAttributes => {
  const defaultHostName = site.properties?.defaultHostName ?? "";
  return {
    functionAppName: extras.name,
    functionAppId: site.id ?? "",
    resourceGroup: extras.resourceGroup,
    location: site.location ?? "",
    defaultHostName,
    url: `https://${defaultHostName}`,
    principalId: site.identity?.principalId,
    storageAccountName: extras.storageAccountName,
    managedApp: extras.managedApp,
    codeHash: extras.codeHash,
    settingKeys: extras.settingKeys,
    eventSubscriptions: extras.eventSubscriptions,
  };
};

/**
 * Overlay the desired settings on the observed ones, dropping keys this
 * resource wrote before but no longer wants. Settings another owner wrote
 * stay as they are.
 */
const syncAppSettings = Effect.fn(function* (options: {
  where: { subscriptionId: string; resourceGroupName: string; name: string };
  desired: Record<string, string>;
  previousKeys: string[];
}) {
  const observed = (yield* web.ListWebAppApplicationSettings(options.where)).properties ?? {};
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(observed)) {
    if (value !== undefined) next[key] = value;
  }
  for (const key of options.previousKeys) {
    if (!(key in options.desired)) delete next[key];
  }
  Object.assign(next, options.desired);
  const changed =
    Object.keys(next).length !== Object.keys(observed).length ||
    Object.entries(next).some(([key, value]) => observed[key] !== value);
  if (changed) {
    yield* web.UpdateWebAppApplicationSettings({ ...options.where, properties: next });
  }
});

export const FunctionProvider = () =>
  Provider.effect(
    Function,
    Effect.gen(function* () {
      const bundle = yield* makeBundler;

      return Function.Provider.of({
        stables: ["functionAppName", "functionAppId", "resourceGroup", "location", "managedApp"],
        nuke: { dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Web.AppServicePlan"] },

        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          const props = news as FunctionProps;
          const managed = props.app === undefined;
          if (
            managed !== output.managedApp ||
            (props.app !== undefined &&
              (!sameName(props.app.siteName, output.functionAppName) ||
                !sameName(props.app.resourceGroup, output.resourceGroup))) ||
            (props.name !== undefined && !sameName(props.name, output.functionAppName)) ||
            (props.resourceGroup !== undefined &&
              !sameName(props.resourceGroup, output.resourceGroup)) ||
            (props.location !== undefined &&
              !sameName(props.location.replaceAll(" ", ""), output.location.replaceAll(" ", "")))
          ) {
            return { action: "replace" } as const;
          }
          // A code-only change leaves the props untouched: compare bundles.
          const { codeHash } = yield* bundle(props);
          if (codeHash !== output.codeHash) return { action: "update" } as const;
          return undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { subscriptionId } = yield* AzureEnvironment.current;
          const resourceGroup =
            output?.resourceGroup ?? olds?.app?.resourceGroup ?? olds?.resourceGroup;
          if (resourceGroup === undefined) return undefined;
          const name =
            output?.functionAppName ??
            olds?.app?.siteName ??
            olds?.name ??
            (yield* createAppName(id));
          const site = yield* getSite(subscriptionId, resourceGroup, name);
          if (site === undefined) return undefined;
          const managedApp = output?.managedApp ?? olds?.app === undefined;
          const attrs = toAttrs(site, {
            resourceGroup,
            name,
            managedApp,
            storageAccountName: output?.storageAccountName,
            codeHash: output?.codeHash ?? "",
            settingKeys: output?.settingKeys ?? [],
            eventSubscriptions: output?.eventSubscriptions ?? [],
          });
          if (!managedApp) return attrs;
          return (yield* isOwned(id, site.tags)) ? attrs : Unowned(attrs);
        }),

        list: Effect.fn(function* () {
          const { subscriptionId } = yield* AzureEnvironment.current;
          const page = yield* collectAll(web.ListWebApps, { subscriptionId });
          return (page.value ?? []).flatMap((site) => {
            const group = resourceGroupOf(site.id);
            return hasAnyAlchemyTag(site.tags) &&
              site.tags?.[RUNTIME_TAG] === FunctionTypeId &&
              group !== undefined &&
              site.name !== undefined
              ? [
                  toAttrs(site, {
                    resourceGroup: group,
                    name: site.name,
                    managedApp: true,
                    storageAccountName: undefined,
                    codeHash: "",
                    settingKeys: [],
                    eventSubscriptions: [],
                  }),
                ]
              : [];
          });
        }),

        reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
          const env = yield* AzureEnvironment.current;
          const { subscriptionId } = env;
          const stack = yield* Stack;
          yield* ensureRegistered(subscriptionId, "Microsoft.Web");
          const collected = collectBindings(bindings as ResourceBinding<FunctionBinding>[]);
          const managed = news.app === undefined;
          const resourceGroup = news.app?.resourceGroup ?? news.resourceGroup;
          if (resourceGroup === undefined) {
            return yield* new FunctionHostingMissing({
              message: `Azure.Functions.Function "${id}" has no resource group`,
            });
          }
          const name =
            news.app?.siteName ??
            news.name ??
            output?.functionAppName ??
            (yield* createAppName(id));
          const where = { subscriptionId, resourceGroupName: resourceGroup, name };

          // Desired app settings: the host's storage, the runtime's stack
          // identity, then binding env, then the user's env.
          const desired: Record<string, string> = {};
          if (managed && news.hosting !== undefined) {
            desired.AzureWebJobsStorage__accountName = news.hosting.storageAccountName;
          }
          // `GET /` goes to `fetch`, not the host's default landing page.
          desired.AzureWebJobsDisableHomepage = "true";
          desired.ALCHEMY_STACK_NAME = stack.name;
          desired.ALCHEMY_STAGE = stack.stage;
          desired.ALCHEMY_PHASE = "runtime";
          for (const [key, value] of Object.entries({ ...collected.env, ...news.env })) {
            if (value !== undefined) desired[key] = envString(value);
          }

          // Observe.
          let site = yield* getSite(subscriptionId, resourceGroup, name);

          if (managed) {
            const hosting = news.hosting;
            if (hosting === undefined) {
              return yield* new FunctionHostingMissing({
                message: `Azure.Functions.Function "${id}" has no hosting (plan and storage)`,
              });
            }
            const tags = {
              ...(yield* desiredTags(id, news.tags)),
              [RUNTIME_TAG]: FunctionTypeId,
            };
            const functionAppConfig: web.FunctionAppConfig = {
              deployment: {
                storage: {
                  type: "blobContainer",
                  value: `${hosting.blobEndpoint.replace(/\/+$/, "")}/${hosting.deploymentContainer}`,
                  authentication: { type: "SystemAssignedIdentity" },
                },
              },
              runtime: { name: "node", version: "22" },
              scaleAndConcurrency: {
                maximumInstanceCount: news.maximumInstanceCount ?? 100,
                instanceMemoryMB: news.instanceMemoryMB ?? 2048,
              },
            };
            const location = news.location ?? output?.location ?? env.location;
            const put = web.WebAppsCreateOrUpdate({
              ...where,
              location,
              kind: "functionapp,linux",
              tags,
              identity: { type: "SystemAssigned" },
              properties: {
                serverFarmId: hosting.serverFarmId,
                reserved: true,
                httpsOnly: true,
                functionAppConfig,
                siteConfig: {
                  appSettings: Object.entries(desired).map(([key, value]) => ({
                    name: key,
                    value,
                  })),
                },
              },
            });
            const waitReady = waitForProvisioned(
              `function app ${name}`,
              getSite(subscriptionId, resourceGroup, name),
              siteState,
              { interval: "3 seconds", times: 60 },
            );
            // Ensure, then sync the PUT-only parts (runtime, scale, tags, identity).
            const observedConfig = site?.properties?.functionAppConfig;
            if (
              site === undefined ||
              tagsDiffer(site.tags, tags) ||
              site.identity?.principalId === undefined ||
              observedConfig?.runtime?.version !== "22" ||
              observedConfig?.scaleAndConcurrency?.maximumInstanceCount !==
                functionAppConfig.scaleAndConcurrency?.maximumInstanceCount ||
              observedConfig?.scaleAndConcurrency?.instanceMemoryMB !==
                functionAppConfig.scaleAndConcurrency?.instanceMemoryMB
            ) {
              yield* put;
            }
            site = yield* waitReady;
          } else if (site === undefined) {
            return yield* new FunctionAppNotFound({
              functionAppName: name,
              message: `function app ${name} in ${resourceGroup} does not exist`,
            });
          }

          const defaultHostName = site.properties?.defaultHostName;
          const principalId = site.identity?.principalId;
          if (defaultHostName === undefined || site.id === undefined) {
            return yield* new FunctionAppNotFound({
              functionAppName: name,
              message: `function app ${name} has no default host name yet`,
            });
          }

          // Grant the host's storage roles and the binding roles to the identity.
          const grants: FunctionRoleAssignment[] = [
            ...(managed && news.hosting !== undefined
              ? HOST_STORAGE_ROLES.map((roleDefinitionId) => ({
                  roleDefinitionId,
                  scope: news.hosting!.storageAccountId,
                }))
              : []),
            ...collected.grants,
          ];
          if (principalId !== undefined) {
            yield* syncBindingAssignments({
              id,
              subscriptionId,
              appId: site.id,
              principalId,
              grants,
            });
          } else if (grants.length > 0) {
            return yield* new FunctionIdentityMissing({
              functionAppName: name,
              message: `function app ${name} needs a system-assigned identity for its role assignments`,
            });
          }

          yield* syncAppSettings({
            where,
            desired,
            previousKeys: output?.settingKeys ?? [],
          });

          // Deploy when the package changed (or the app is new).
          const { files, codeHash } = yield* bundle(news);
          if (output?.codeHash !== codeHash || output.functionAppName !== name) {
            const archive = yield* zipFiles(files);
            yield* deployPackage({
              functionAppName: name,
              scmHostName: scmHostOf(site, defaultHostName),
              archive: new Uint8Array(archive),
            });
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
            siteId: site.id,
            desired: collected.eventSubscriptions,
            previous: output?.eventSubscriptions ?? [],
          });

          return toAttrs(site, {
            resourceGroup,
            name,
            managedApp: managed,
            storageAccountName: news.hosting?.storageAccountName,
            codeHash,
            settingKeys: Object.keys(desired).sort(),
            eventSubscriptions,
          });
        }),

        delete: Effect.fn(function* ({ id, output }) {
          const { subscriptionId } = yield* AzureEnvironment.current;
          const where = {
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            name: output.functionAppName,
          };
          for (const sub of output.eventSubscriptions) {
            yield* ignoreNotFound(
              eventgrid.DeleteEventSubscription({
                scope: sub.scope,
                eventSubscriptionName: sub.name,
              }),
            );
          }
          const site = yield* getSite(subscriptionId, output.resourceGroup, output.functionAppName);
          if (site === undefined) return;
          // Role assignments outlive their principal; revoke them first.
          const principalId = site.identity?.principalId ?? output.principalId;
          if (principalId !== undefined) {
            yield* syncBindingAssignments({
              id,
              subscriptionId,
              appId: site.id ?? output.functionAppId,
              principalId,
              grants: [],
            });
          }
          if (output.managedApp) {
            yield* ignoreNotFound(web.DeleteWebApp({ ...where, deleteEmptyServerFarm: false }));
            yield* waitUntilGone(
              `function app ${output.functionAppName}`,
              getSite(subscriptionId, output.resourceGroup, output.functionAppName),
              { interval: "5 seconds", times: 36 },
            );
            return;
          }
          // An app Alchemy did not create keeps everything but our settings.
          if (output.settingKeys.length === 0) return;
          const observed = yield* orUndefinedIfNotFound(web.ListWebAppApplicationSettings(where));
          if (observed === undefined) return;
          const next: Record<string, string> = {};
          for (const [key, value] of Object.entries(observed.properties ?? {})) {
            if (value !== undefined && !output.settingKeys.includes(key)) next[key] = value;
          }
          yield* ignoreNotFound(
            web.UpdateWebAppApplicationSettings({ ...where, properties: next }),
          );
        }),
      });
    }),
  );
