import type { Credentials } from "@distilled.cloud/azure";
import * as kudu from "@distilled.cloud/azure/kudu";
import type * as web from "@distilled.cloud/azure/web";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Bundle from "alchemy/Bundle/Bundle";
import { findCwdForBundle, resolveMainPath } from "alchemy/Bundle/TempRoot";
import { isResolved } from "alchemy/Diff";
import type { Input, InputProps } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource, ResourceBinding } from "alchemy/Resource";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "alchemy/Runtime/Process";
import { packEnvValue } from "alchemy/RuntimeContext";
import { Stack } from "alchemy/Stack";
import { sha256Object } from "alchemy/Util/sha256";
import { zipFiles } from "alchemy/Util/zip";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { orUndefinedIfNotFound } from "../Arm.ts";
import { managedIdentityHostBundle, type HostRoleAssignment } from "../AzureBindings.ts";
import { syncBindingAssignments } from "../ContainerApps/ContainerApp.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { stackResourceGroup } from "../StackResourceGroup.ts";
import { AppServicePlan } from "./AppServicePlan.ts";
import {
  getSite,
  makeSiteLifecycle,
  type SiteAttributes,
  type SiteIdentity,
  type SiteProps,
} from "./Site.ts";

export type { InferEnv } from "../InferEnv.ts";

export const WebAppTypeId = "Azure.Web.WebApp" as const;
export type WebAppTypeId = typeof WebAppTypeId;

/**
 * Binding contract accepted by `Azure.Web.WebApp` (the Azure `HostBinding`
 * shape):
 *
 * - `roleAssignments` are granted to the app's system-assigned identity;
 *   the ones a deploy no longer asks for are revoked (only ones it made).
 * - `env` becomes app settings.
 */
export interface WebAppBinding {
  roleAssignments?: HostRoleAssignment[];
  env?: Record<string, unknown>;
}

export interface WebAppProps<Env extends Record<string, any> = Record<string, any>>
  extends Omit<SiteProps, "resourceGroup" | "serverFarmId">, PlatformProps {
  /**
   * Resource group of the app (and of the plan Alchemy creates for it).
   * Changing it replaces the app.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup?: string;
  /**
   * ARM resource ID of the App Service plan the app runs on. Moving to a
   * plan in another resource group replaces the app.
   * @default a Linux plan Alchemy creates for the app, sized by `sku`
   */
  serverFarmId?: string;
  /**
   * SKU of the App Service plan Alchemy creates when `serverFarmId` is
   * omitted, e.g. `F1` (free, 60 CPU minutes a day), `B1`, `P0v3`.
   * @default "B1"
   */
  sku?: string;
  /**
   * Entry module of a program Alchemy bundles and deploys onto the app. For
   * an Effect web app this is `import.meta.url` (the file is both the bundle
   * entry and the program). For an async web app it is a handler file that
   * default-exports `{ fetch(request, env) }`. Alchemy bundles it for
   * Node.js 22 into one ESM file, sets the start command to
   * `node index.mjs`, and zip-deploys it. Requires `os: "linux"`.
   *
   * Omit it to manage only the app's configuration (deploy code another
   * way, e.g. with `Azure.Web.SourceControl` or a container image).
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
   * On an async web app, {@link InferEnv} types the handler's `env`
   * argument from this object.
   */
  env?: Env;
}

/** Attributes of `Azure.Web.WebApp`. */
export interface WebAppAttributes extends SiteAttributes {
  /** Hash of the deployed package, when Alchemy deploys `main`. */
  codeHash: string | undefined;
}

export interface WebApp<Env extends Record<string, any> = Record<string, any>> extends Resource<
  WebAppTypeId,
  WebAppProps<Env>,
  WebAppAttributes,
  WebAppBinding,
  Providers
> {}

export type WebAppServices = Credentials | ServerHost;
export type WebAppShape = Main<WebAppServices>;

/** Runtime context of an App Service web app: `serve` for `fetch`, `run` for loops. */
export type WebAppRuntimeContext = HostRuntimeContext;

/** Plan SKU when Alchemy creates the plan. */
const DEFAULT_SKU = "B1";

const transformWebAppProps = (id: string, props: WebAppProps) =>
  Effect.gen(function* () {
    // Composition is a deploy concern; inside the bundle props are final.
    if (globalThis.__ALCHEMY_RUNTIME__) return props;
    const resourceGroup = props.resourceGroup ?? (yield* stackResourceGroup).name;
    if (props.serverFarmId !== undefined) return { ...props, resourceGroup };
    const plan = yield* AppServicePlan("Plan", {
      resourceGroup,
      location: props.location,
      sku: props.sku ?? DEFAULT_SKU,
      os: props.os ?? "linux",
      tags: props.tags,
    }).pipe(Namespace.push(id));
    return { ...props, resourceGroup, serverFarmId: plan.appServicePlanId };
  });

/**
 * An Azure App Service web app (`Microsoft.Web/sites`, kind `app`): an
 * always-available HTTP host on an App Service plan.
 *
 * Use it two ways. Pass `main` and Alchemy bundles your Node.js 22
 * program, deploys it, and runs it as the app's system-assigned managed
 * identity, so bindings reach Azure without secrets. Omit `main` and the
 * resource manages only the app's configuration.
 *
 * On every deploy Alchemy syncs the site properties, the site
 * configuration (`config/web`), the app settings, the managed identity,
 * the identity's role assignments, and tags against the live app. HTTPS
 * only is on by default.
 *
 * :::caution[Changing `name`, `resourceGroup`, `location`, or `os` replaces the app]
 * A new app is created (with a new generated name), and the old one is
 * deleted. Moving `serverFarmId` to a plan in another resource group also
 * replaces it.
 * :::
 *
 * :::note[Event sources]
 * A web app is triggered by HTTP only. For queue, blob, Event Grid, Service
 * Bus, Event Hubs, Cosmos DB, or timer triggers use
 * `Azure.Functions.Function`; for KEDA-scaled consumers use
 * `Azure.ContainerApps.ContainerApp`.
 * :::
 *
 * :::caution[An idle app unloads after 20 minutes]
 * `alwaysOn` is off unless you set it. Azure then unloads the app after 20
 * minutes without requests: the next request waits for a cold start, and
 * `host.run` loops stop until then. Set `siteConfig: { alwaysOn: true }` on
 * a Basic or higher plan. The free `F1` plan cannot stay on and has 60 CPU
 * minutes a day.
 * :::
 *
 * :::caution[`main` deploys to Linux only]
 * With `main`, Alchemy sets the stack to `NODE|22-lts` and the start
 * command to `node index.mjs`, and `os: "windows"` fails with
 * `WebAppRuntimeUnsupported`. Each deploy whose bundle changed zip-deploys
 * it and restarts the app.
 * :::
 *
 * @see https://learn.microsoft.com/azure/app-service/overview
 *
 * ### Effect Web Apps
 * A web app is a class. Props describe the app, and the Effect is the
 * program. `main: import.meta.url` makes the file both the bundle entry and
 * the program. Init binds resources once per instance; the returned `fetch`
 * runs per request.
 *
 * **Example:** Effect web app with an HTTP handler
 * ```typescript
 * // src/api.ts
 * import * as Azure from "@alchemy.run/azure";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export default class Api extends Azure.Web.WebApp<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello from App Service")),
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
 * **Example:** Background work next to `fetch`
 * ```typescript
 * Effect.gen(function* () {
 *   const host = yield* ServerHost;
 *   yield* host.run(
 *     Effect.log("tick").pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
 *   );
 *   return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 * })
 * ```
 *
 * ### Async Web Apps
 * You don't have to use Effect. Call the web app with `main` pointing at a
 * plain handler file and no implementation. Alchemy bundles that file as-is
 * (no Effect runtime in it) behind a Node HTTP server. The `env` prop takes
 * literals, `Config` values, and resources, and {@link InferEnv} types the
 * handler's `env` argument.
 *
 * **Example:** Declaring an async web app
 * ```typescript
 * // alchemy.run.ts
 * export const Hello = Azure.Web.WebApp("Hello", {
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
 * **Example:** Name, location, plan size, and app settings
 * ```typescript
 * export default class Api extends Azure.Web.WebApp<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     name: "contoso-api",
 *     location: "westeurope",
 *     sku: "P0v3",
 *     appSettings: { NODE_ENV: "production" },
 *     siteConfig: { healthCheckPath: "/healthz", minTlsVersion: "1.2", ftpsState: "Disabled" },
 *     tags: { team: "web" },
 *   },
 *   program,
 * ) {}
 * ```
 *
 * **Example:** Run on a plan you manage
 * ```typescript
 * const plan = yield* Azure.Web.AppServicePlan("Plan", { sku: "P1v3" });
 * const api = yield* Azure.Web.WebApp("Api", {
 *   main: "./src/api.ts",
 *   serverFarmId: plan.appServicePlanId,
 * });
 * ```
 *
 * ### Bundling
 * Alchemy bundles `main` and its imports with Rolldown into one ESM file
 * for Node.js 22, zips it with a `package.json`, and deploys it without a
 * remote build, so the app has no `node_modules`: every import must be in
 * the bundle. Pass Rolldown options on `build`.
 *
 * **Example:** Mark more packages as side-effect free
 * ```typescript
 * export default class Api extends Azure.Web.WebApp<Api>()(
 *   "Api",
 *   { main: import.meta.url, build: { pure: { packages: ["zod"] } } },
 *   program,
 * ) {}
 * ```
 *
 * **Example:** Ship a source map
 * ```typescript
 * export default class Api extends Azure.Web.WebApp<Api>()(
 *   "Api",
 *   { main: import.meta.url, build: { output: { sourcemap: true } } },
 *   program,
 * ) {}
 * ```
 *
 * ### Scaling
 * A web app scales with its plan: every instance of the plan runs the app.
 * Size the plan with `sku`, or create an `Azure.Web.AppServicePlan` with
 * `capacity` (instance count) and pass its `serverFarmId`. Turn on
 * `alwaysOn` (Basic and higher) so the app never idles out.
 *
 * **Example:** Three always-on instances
 * ```typescript
 * const plan = yield* Azure.Web.AppServicePlan("Plan", { sku: "P1v3", capacity: 3 });
 * const api = yield* Azure.Web.WebApp("Api", {
 *   main: "./src/api.ts",
 *   serverFarmId: plan.appServicePlanId,
 *   siteConfig: { alwaysOn: true },
 * });
 * ```
 *
 * ### Storage Bindings
 * Bindings grant the app's managed identity the smallest data role on the
 * bound resource only, and hand the program a typed client. Provide the
 * `*Http` layer of each binding on the program. `BlobContainerReadWrite`
 * grants **Storage Blob Data Contributor** on the container.
 *
 * **Example:** Read and write blobs
 * ```typescript
 * Effect.gen(function* () {
 *   // init
 *   const files = yield* Azure.Storage.BlobContainerReadWrite(uploads);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       // runtime
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
 * // init: Storage Queue Data Message Sender on the queue
 * const jobs = yield* Azure.Storage.QueueSend(queue);
 *
 * // runtime
 * yield* jobs.send(JSON.stringify({ id: 1 }));
 * // …provided with Effect.provide(Azure.Storage.QueueSendHttp)
 * ```
 *
 * ### Key Vault Bindings
 * `SecretRead` grants **Key Vault Secrets User** on the one secret.
 *
 * **Example:** Read a secret
 * ```typescript
 * // init
 * const apiKey = yield* Azure.KeyVault.SecretRead(secret);
 *
 * // runtime: the latest version, as a Redacted<string>
 * const key = yield* apiKey.get();
 * // …provided with Effect.provide(Azure.KeyVault.SecretReadHttp)
 * ```
 *
 * ### Service Bus Bindings
 * `QueueSend` grants **Azure Service Bus Data Sender** on the queue, and
 * `TopicWrite` grants it on the topic.
 *
 * **Example:** Send to a queue and publish to a topic
 * ```typescript
 * // init
 * const orders = yield* Azure.ServiceBus.QueueSend(queue);
 * const events = yield* Azure.ServiceBus.TopicWrite(topic);
 *
 * // runtime
 * yield* orders.send({ id: 1 }, { messageId: "order-1" });
 * yield* events.send({ type: "order.created", orderId: "1" }, { label: "order" });
 * // …provided with Azure.ServiceBus.QueueSendHttp and Azure.ServiceBus.TopicWriteHttp
 * ```
 *
 * ### Event Hubs Bindings
 * `Send` grants **Azure Event Hubs Data Sender** on the event hub.
 *
 * **Example:** Send an event
 * ```typescript
 * // init
 * const readings = yield* Azure.EventHub.Send(hub);
 *
 * // runtime
 * yield* readings.send({ deviceId: "d1", temperature: 21 }, { partitionKey: "d1" });
 * // …provided with Effect.provide(Azure.EventHub.SendHttp)
 * ```
 *
 * ### Cosmos DB Bindings
 * `SqlContainerReadWrite` assigns a Cosmos DB data-plane role scoped to the
 * one container.
 *
 * **Example:** Upsert and query documents
 * ```typescript
 * // init
 * const orders = yield* Azure.CosmosDB.SqlContainerReadWrite(ordersContainer);
 *
 * // runtime
 * yield* orders.upsert({
 *   document: { id: "o-1", tenant: "t1", status: "open" },
 *   partitionKey: ["t1"],
 * });
 * const { Documents } = yield* orders.query({
 *   query: "SELECT * FROM c WHERE c.status = @status",
 *   parameters: [{ name: "@status", value: "open" }],
 * });
 * // …provided with Effect.provide(Azure.CosmosDB.SqlContainerReadWriteHttp)
 * ```
 *
 * ### Controlling the App from a Runtime
 * `StartWebApp`, `StopWebApp`, and `RestartWebApp` let another runtime
 * operate the app. Each grants a custom role with only its one action, on
 * this app only.
 *
 * **Example:** Restart the app from a Function
 * ```typescript
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const site = yield* Site;
 *     // init
 *     const restart = yield* Azure.Web.RestartWebApp(site);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         yield* restart({ softRestart: true });
 *         return HttpServerResponse.text("accepted");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Web.RestartWebAppHttp)),
 * ) {}
 * ```
 *
 * ### Custom Role Grants
 * **Example:** Grant a role the program uses directly
 * ```typescript
 * const host = yield* Azure.Web.WebApp;
 * if (!globalThis.__ALCHEMY_RUNTIME__) {
 *   yield* host.bind`Reader(${host})`({
 *     roleAssignments: [
 *       { roleDefinitionId: Azure.Authorization.BuiltInRole.Reader, scope: group.resourceGroupId },
 *     ],
 *   });
 * }
 * ```
 *
 * ### Networking
 * `virtualNetworkSubnetId` routes the app's outbound traffic through a
 * subnet delegated to `Microsoft.Web/serverFarms` (Basic plan or higher),
 * so the app reaches private endpoints and VMs in the virtual network.
 *
 * **Example:** Outbound traffic through a delegated subnet
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("Apps", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 *   delegations: [{ serviceName: "Microsoft.Web/serverFarms" }],
 * });
 * const api = yield* Azure.Web.WebApp("Api", {
 *   main: "./src/api.ts",
 *   sku: "P0v3",
 *   virtualNetworkSubnetId: subnet.subnetId,
 * });
 * ```
 *
 * **Example:** Allow one IP range and block the rest
 * ```typescript
 * const api = yield* Azure.Web.WebApp("Api", {
 *   main: "./src/api.ts",
 *   siteConfig: {
 *     ipSecurityRestrictions: [
 *       { name: "office", ipAddress: "203.0.113.0/24", action: "Allow", priority: 100 },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Custom Domains
 * Azure verifies a hostname when you bind it: the domain needs a CNAME to
 * `defaultHostName` and an `asuid.<name>` TXT record holding
 * `customDomainVerificationId`. Make `hostName` depend on both records so
 * Alchemy creates them first. A TLS binding also needs a certificate and a
 * Basic or higher plan.
 *
 * **Example:** `www` in an Azure DNS zone
 * ```typescript
 * import * as Output from "alchemy/Output";
 *
 * const zone = yield* Azure.Dns.Zone("Zone", { name: "example.com" });
 * const cname = yield* Azure.Dns.RecordSet("WwwCname", {
 *   zoneName: zone.zoneName,
 *   recordType: "CNAME",
 *   name: "www",
 *   cname: api.defaultHostName,
 * });
 * const verify = yield* Azure.Dns.RecordSet("WwwVerify", {
 *   zoneName: zone.zoneName,
 *   recordType: "TXT",
 *   name: "asuid.www",
 *   txtRecords: [api.customDomainVerificationId.as<string>()],
 * });
 * yield* Azure.Web.HostNameBinding("Www", {
 *   siteName: api.siteName,
 *   hostName: Output.map(
 *     Output.all(cname.recordSetName, verify.recordSetName),
 *     () => "www.example.com",
 *   ),
 * });
 * ```
 *
 * ### Configuration-only Web Apps
 * **Example:** Node.js app on a free Linux plan
 * ```typescript
 * const plan = yield* Azure.Web.AppServicePlan("plan", {
 *   sku: "F1",
 * });
 * const app = yield* Azure.Web.WebApp("site", {
 *   serverFarmId: plan.appServicePlanId,
 *   siteConfig: { linuxFxVersion: "NODE|20-lts", alwaysOn: false },
 * });
 * ```
 *
 * **Example:** System-assigned identity
 * ```typescript
 * const app = yield* Azure.Web.WebApp("site", {
 *   serverFarmId: plan.appServicePlanId,
 *   identity: { type: "SystemAssigned" },
 * });
 * // app.principalId can be granted roles with Azure.Authorization.RoleAssignment
 * ```
 *
 * @resource
 * @category Web
 */
export const WebApp: Platform<
  WebApp,
  WebAppServices,
  WebAppShape,
  WebAppRuntimeContext,
  {},
  WebAppProps
> & {
  /**
   * Async (no-impl) constructor: captures the `env` literal so
   * {@link InferEnv} types the handler's `env` argument.
   */
  <const Env extends Record<string, any>, PropsReq = never>(
    id: string,
    props:
      | InputProps<WebAppProps<Env>>
      | Effect.Effect<InputProps<WebAppProps<Env>>, never, PropsReq>,
  ): Effect.Effect<WebApp<Env>, never, Providers | PropsReq>;
} = Platform(WebAppTypeId, {
  createRuntimeContext: createHostRuntimeContext(WebAppTypeId),
  transformProps: (id, props) => transformWebAppProps(id, props),
});

export class WebAppDeployFailed extends Data.TaggedError("Azure.Web.WebAppDeployFailed")<{
  siteName: string;
  message: string;
}> {}

export class WebAppHostingMissing extends Data.TaggedError("Azure.Web.WebAppHostingMissing")<{
  message: string;
}> {}

export class WebAppRuntimeUnsupported extends Data.TaggedError(
  "Azure.Web.WebAppRuntimeUnsupported",
)<{ message: string }> {}

export class WebAppIdentityMissing extends Data.TaggedError("Azure.Web.WebAppIdentityMissing")<{
  siteName: string;
  message: string;
}> {}

/** Node.js stack and start command of an app Alchemy deploys code to. */
const NODE_STACK = "NODE|22-lts";
const START_COMMAND = "node index.mjs";

const PACKAGE_JSON = `${JSON.stringify({ type: "module", main: "index.mjs" }, null, 2)}\n`;

/** Generated entry of an Effect web app: raise the runtime flag, run init, serve. */
const effectEntry = (handler: string) => (importPath: string) =>
  `
import { bootstrap } from "@alchemy.run/azure/Bootstrap/WebApp";

globalThis.__ALCHEMY_RUNTIME__ = true;
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});

await bootstrap(entrypoint);
`;

/** Generated entry of an async web app: no Effect, just the handler file. */
const asyncEntry = (handler: string, envKeys: readonly string[]) => (importPath: string) =>
  `
import { serve } from "@alchemy.run/azure/Bootstrap/WebAppAsync";
import { ${handler} as handler } from ${JSON.stringify(importPath)};

serve(handler, ${JSON.stringify(envKeys)});
`;

const makeBundler = Effect.gen(function* () {
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
  return Effect.fn(function* (props: WebAppProps & { main: string }) {
    const realMain = yield* resolveMainPath(props.main);
    const cwd = yield* findCwdForBundle(realMain);
    const handler = props.handler ?? "default";
    const envKeys = Object.keys(props.env ?? {}).sort();
    const entry = props.isExternal ? asyncEntry(handler, envKeys) : effectEntry(handler);
    const output = yield* Bundle.build(
      managedIdentityHostBundle({
        ...props.build?.input,
        input: realMain,
        cwd,
        platform: "node",
        resolve: {
          conditionNames: [...Bundle.NODE_CONDITION_NAMES],
          ...props.build?.input?.resolve,
        },
        plugins: [props.build?.input?.plugins, virtualEntryPlugin(entry)],
      }),
      {
        ...props.build?.output,
        format: "esm",
        sourcemap: props.build?.output?.sourcemap ?? false,
        entryFileNames: "index.mjs",
      },
      props.build,
    );
    const files = [
      ...output.files.map((file) => ({
        path: file.path,
        content:
          typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content,
      })),
      { path: "package.json", content: PACKAGE_JSON },
    ];
    const codeHash = (yield* sha256Object({
      bundle: output.hash,
      package: PACKAGE_JSON,
      envKeys: props.isExternal ? envKeys : [],
    })).slice(0, 16);
    return { files, codeHash };
  });
});

const envString = (value: unknown): string =>
  typeof value === "string" ? value : packEnvValue(value);

const collectBindings = (bindings: ResourceBinding<WebAppBinding>[]) => {
  const env: Record<string, unknown> = {};
  const grants = new Map<string, HostRoleAssignment>();
  const active = bindings.filter(
    (b: ResourceBinding<WebAppBinding> & { action?: string }) => b.action !== "delete",
  );
  for (const binding of active) {
    Object.assign(env, binding.data.env ?? {});
    for (const grant of binding.data.roleAssignments ?? []) {
      grants.set(`${grant.scope.toLowerCase()}|${grant.roleDefinitionId.toLowerCase()}`, grant);
    }
  }
  return { env, grants: [...grants.values()] };
};

/** Add the system-assigned identity the program and its bindings run as. */
const withSystemIdentity = (identity: SiteIdentity | undefined): SiteIdentity =>
  identity === undefined || identity.type === "SystemAssigned"
    ? { type: "SystemAssigned" }
    : { ...identity, type: "SystemAssigned, UserAssigned" };

/** `name.region.azurewebsites.net` → `name.scm.region.azurewebsites.net`. */
const scmHostOf = (site: web.GetWebAppResponse | undefined, defaultHostName: string) =>
  site?.properties?.hostNameSslStates?.find((state) => state.hostType === "Repository")?.name ??
  [defaultHostName.split(".")[0], "scm", ...defaultHostName.split(".").slice(1)].join(".");

/** Kudu deployment status: 3 failed, 4 succeeded. */
const DEPLOY_FAILED = 3;
const DEPLOY_SUCCEEDED = 4;

/** Zip-deploy the package with OneDeploy and wait for the deployment to finish. */
const deployPackage = (options: { siteName: string; scmHostName: string; archive: Uint8Array }) =>
  Effect.gen(function* () {
    const { scmHostName } = options;
    const before = yield* orUndefinedIfNotFound(kudu.GetLatestDeployment({ scmHostName }));
    yield* kudu
      .DeployArtifact({
        scmHostName,
        body: options.archive,
        contentType: "application/zip",
        type: "zip",
        clean: true,
        RemoteBuild: false,
        Deployer: "alchemy",
      })
      .pipe(
        // Another deployment, or the new site's first start, is running.
        Effect.retry({
          while: (e) => e._tag === "KuduDeploymentInProgress",
          schedule: Schedule.spaced("10 seconds"),
          times: 12,
        }),
      );
    const latest = yield* orUndefinedIfNotFound(kudu.GetLatestDeployment({ scmHostName })).pipe(
      Effect.repeat({
        until: (d) => d !== undefined && d.id !== before?.id && d.complete === true,
        schedule: Schedule.spaced("5 seconds"),
        times: 60,
      }),
    );
    if (latest?.status !== DEPLOY_SUCCEEDED) {
      return yield* new WebAppDeployFailed({
        siteName: options.siteName,
        message:
          latest?.status === DEPLOY_FAILED
            ? `deployment ${latest.id} failed: ${latest.statusText ?? latest.message ?? ""}`
            : `deployment did not finish (last status ${latest?.status ?? "unknown"})`,
      });
    }
  });

const lifecycle = makeSiteLifecycle<SiteProps>({
  kind: "app",
  maxNameLength: 60,
  platformAppSettings: () => ({}),
  putOnlyProperties: () => ({}),
});

/**
 * `transformProps` fills `resourceGroup` and `serverFarmId` before the
 * engine sees the props, so they are `SiteProps` from here on.
 */
const asSiteProps = (props: WebAppProps) => props as SiteProps;

export const WebAppProvider = () =>
  Provider.effect(
    WebApp,
    Effect.gen(function* () {
      const bundle = yield* makeBundler;

      return WebApp.Provider.of({
        stables: lifecycle.stables,
        nuke: {
          dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Web.AppServicePlan"],
        },

        list: Effect.fn(function* () {
          const sites = yield* lifecycle.list();
          return sites.map((site): WebAppAttributes => ({ ...site, codeHash: undefined }));
        }),

        diff: Effect.fn(function* ({ news, olds, output }) {
          const replace = yield* lifecycle.diff({
            news: news as Input<SiteProps>,
            olds: asSiteProps(olds),
            output,
          });
          if (replace !== undefined) return replace;
          if (!isResolved(news) || output === undefined) return undefined;
          const props = news as WebAppProps;
          if (props.main === undefined) return undefined;
          // A code-only change leaves the props untouched: compare bundles.
          const { codeHash } = yield* bundle({ ...props, main: props.main });
          return codeHash !== output.codeHash ? ({ action: "update" } as const) : undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const attrs = yield* lifecycle.read({
            id,
            olds: olds === undefined ? undefined : asSiteProps(olds),
            output,
          });
          if (attrs === undefined) return undefined;
          const withHash: WebAppAttributes = { ...attrs, codeHash: output?.codeHash };
          return Unowned.is(attrs) ? Unowned(withHash) : withHash;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
          const { subscriptionId } = yield* AzureEnvironment.current;
          const collected = collectBindings(bindings as ResourceBinding<WebAppBinding>[]);
          const { resourceGroup, serverFarmId, main } = news;
          if (resourceGroup === undefined || serverFarmId === undefined) {
            return yield* new WebAppHostingMissing({
              message: `Azure.Web.WebApp "${id}" has no resource group or App Service plan`,
            });
          }
          const os = news.os ?? "linux";
          if (main !== undefined && os !== "linux") {
            return yield* new WebAppRuntimeUnsupported({
              message: `Azure.Web.WebApp "${id}" deploys "main" to Linux apps only (os is "${os}")`,
            });
          }
          const runsCode = main !== undefined || collected.grants.length > 0;

          // Desired app settings: the runtime's stack identity, then binding
          // env, then the program's env, then the user's raw settings.
          const appSettings: Record<string, string> = {};
          if (main !== undefined) {
            const stack = yield* Stack;
            appSettings.ALCHEMY_STACK_NAME = stack.name;
            appSettings.ALCHEMY_STAGE = stack.stage;
            appSettings.ALCHEMY_PHASE = "runtime";
          }
          for (const [key, value] of Object.entries({ ...collected.env, ...news.env })) {
            if (value !== undefined) appSettings[key] = envString(value);
          }
          Object.assign(appSettings, news.appSettings);

          // Observe, ensure, and sync the site, its config, settings, and identity.
          const site = yield* lifecycle.reconcile({
            id,
            news: {
              ...news,
              resourceGroup,
              serverFarmId,
              os,
              identity: runsCode ? withSystemIdentity(news.identity) : news.identity,
              siteConfig:
                main !== undefined
                  ? {
                      linuxFxVersion: NODE_STACK,
                      appCommandLine: START_COMMAND,
                      ...news.siteConfig,
                    }
                  : news.siteConfig,
              appSettings,
            },
            output,
          });

          // Grant the binding roles to the identity; revoke the ones no binding asks for.
          if (site.principalId !== undefined) {
            yield* syncBindingAssignments({
              id,
              subscriptionId,
              appId: site.siteId,
              principalId: site.principalId,
              grants: collected.grants,
            });
          } else if (collected.grants.length > 0) {
            return yield* new WebAppIdentityMissing({
              siteName: site.siteName,
              message: `web app ${site.siteName} needs a system-assigned identity for its role assignments`,
            });
          }

          if (main === undefined) return { ...site, codeHash: undefined };

          // Deploy when the package changed (or the app is new).
          const { files, codeHash } = yield* bundle({ ...news, main });
          if (output?.codeHash !== codeHash || output.siteName !== site.siteName) {
            const archive = yield* zipFiles(files);
            const observed = yield* getSite(subscriptionId, resourceGroup, site.siteName);
            yield* deployPackage({
              siteName: site.siteName,
              scmHostName: scmHostOf(observed, site.defaultHostName),
              archive: new Uint8Array(archive),
            });
          }
          return { ...site, codeHash };
        }),

        delete: Effect.fn(function* ({ id, output }) {
          const { subscriptionId } = yield* AzureEnvironment.current;
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
