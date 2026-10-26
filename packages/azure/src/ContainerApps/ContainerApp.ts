import { createHash } from "node:crypto";
import type { Credentials } from "@distilled.cloud/azure";
import * as app from "@distilled.cloud/azure/app";
import * as authorization from "@distilled.cloud/azure/authorization";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Bundle from "alchemy/Bundle/Bundle";
import { findCwdForBundle, resolveMainPath } from "alchemy/Bundle/TempRoot";
import { isResolved } from "alchemy/Diff";
import type { InputProps } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource, ResourceBinding } from "alchemy/Resource";
import {
  createContainerRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "alchemy/Runtime/Process";
import { packEnvValueKeepRedacted } from "alchemy/RuntimeContext";
import { Stack } from "alchemy/Stack";
import { sha256Object } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
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
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import {
  descriptionWithMarker,
  normalizeScope,
  ownershipMarker,
} from "../Authorization/Ownership.ts";
import { roleDefinitionIdOf } from "../Authorization/RoleAssignment.ts";
import { managedIdentityHostBundle, type HostRoleAssignment } from "../AzureBindings.ts";
import { Registry } from "../ContainerRegistry/Registry.ts";
import { Token } from "../ContainerRegistry/Token.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { stackResourceGroup } from "../StackResourceGroup.ts";
import {
  createContainerAppsName,
  fingerprint,
  getContainerApp,
  identityMatches,
  lower,
  matchesDesired,
  reveal,
  sameLocation,
  secretsMatch,
  toIdentity,
  toSecrets,
  type ContainerAppsIdentity,
  type ContainerAppsSecret,
} from "./common.ts";
import { APP_DIR, DEFAULT_BASE_IMAGE, pushProgramImage } from "./internal/image.ts";

export type { InferEnv } from "../InferEnv.ts";
export type { ContainerAppsIdentity, ContainerAppsSecret } from "./common.ts";

export const ContainerAppTypeId = "Azure.ContainerApps.ContainerApp" as const;
export type ContainerAppTypeId = typeof ContainerAppTypeId;

/**
 * App-level configuration: ingress, revision mode, registries, Dapr,
 * runtime settings. Secrets are set with the separate `secrets` prop.
 */
export type ContainerAppConfiguration = Omit<app.ConfigurationInput, "secrets">;

/** Versioned template: containers, scale rules, volumes. */
export type ContainerAppTemplate = app.TemplateInput;

/** A KEDA scale rule (`azureQueue`, `custom`, `http`, or `tcp`). */
export type ContainerAppScaleRule = app.ScaleRule;

/**
 * Binding contract accepted by `Azure.ContainerApps.ContainerApp` (the Azure
 * `HostBinding` shape plus scaling):
 *
 * - `roleAssignments` are granted to the app's system-assigned identity;
 *   the ones a deploy no longer asks for are revoked (only ones it made).
 * - `env` becomes container env vars (`Redacted` values become secrets).
 * - `scaleRules` are added to the template's KEDA scale rules (event sources).
 * - `minReplicas` raises the template's minimum replica count (schedules).
 */
export interface ContainerAppBinding {
  roleAssignments?: HostRoleAssignment[];
  env?: Record<string, unknown>;
  scaleRules?: ContainerAppScaleRule[];
  minReplicas?: number;
}

/**
 * The registry Alchemy pushes the program image to and the pull token the
 * app uses. Set automatically when `main` is set.
 * @internal
 */
export interface ContainerAppRegistry {
  registryName: string;
  resourceGroup: string;
  loginServer: string;
  tokenName: string;
  tokenPassword: Redacted.Redacted<string> | undefined;
}

export interface ContainerAppProps<
  Env extends Record<string, any> = Record<string, any>,
> extends PlatformProps {
  /**
   * Resource group the app is created in. Changing it replaces the app.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup?: string;
  /**
   * App name: 2-32 lowercase letters, digits, and hyphens, starting with a
   * letter and without `--`. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the app.
   */
  name?: string;
  /**
   * Azure location; must match the environment's location. Changing it
   * replaces the app.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Container Apps environment (`environment.environmentId`).
   * Changing it replaces the app.
   */
  environmentId: string;
  /**
   * ARM ID of the Azure Arc custom location, when `environmentId` is a
   * `ConnectedEnvironment`. Changing it replaces the app.
   *
   * :::caution
   * Changing `customLocationId` deletes the app and creates a new one.
   * :::
   */
  customLocationId?: string;
  /**
   * Workload profile of the environment to run on.
   * @default the environment's Consumption profile
   */
  workloadProfileName?: string;
  /**
   * App-level configuration (ingress, revision mode, registries, Dapr).
   * With `main`, ingress defaults to external on {@link port}.
   */
  configuration?: ContainerAppConfiguration;
  /**
   * Revision template: containers, scale, and volumes. Changing it
   * creates a new revision. Required without `main`. With `main`, Alchemy
   * puts the program's container (named `main`) first and keeps the
   * template's other containers (sidecars), scale, and volumes.
   */
  template?: ContainerAppTemplate;
  /**
   * Secrets referenced by env vars (`secretRef`), registries
   * (`passwordSecretRef`), and scale rules.
   */
  secrets?: ContainerAppsSecret[];
  /**
   * Managed identity of the app. Apps with `main` or bindings always get a
   * system-assigned identity as well.
   */
  identity?: ContainerAppsIdentity;
  /**
   * App kind: `workflowapp` (Logic Apps Standard host, see
   * `ContainerApps.LogicApp`) or `functionapp`. Changing it replaces the app.
   */
  kind?: "workflowapp" | "functionapp";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
  /**
   * Program entry. For an Effect app this is `import.meta.url` (the file
   * is both the bundle entry and the program). For an async app it is a
   * handler file that default-exports `{ fetch(request, env) }`. Alchemy
   * bundles it for Node.js into one ESM file and pushes it as an image
   * layer on {@link baseImage} to a container registry it creates.
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
   * Environment variables of the program's container. Accepts literals,
   * `Config` values, Outputs, and resources (a resource arrives as its
   * attributes, JSON-encoded). `Redacted` values are stored as app secrets.
   * Merged after the `env` that bindings contribute.
   *
   * On an async app, {@link InferEnv} types the handler's `env` argument
   * from this object.
   */
  env?: Env;
  /**
   * Port the program listens on (`PORT`), and ingress's target port.
   * @default 8080
   */
  port?: number;
  /**
   * vCPUs of the program's container (`0.25` steps; Consumption pairs
   * 0.25 vCPU with 0.5 GiB).
   * @default 0.5
   */
  cpu?: number;
  /**
   * Memory of the program's container, e.g. `"1Gi"`.
   * @default "1Gi"
   */
  memory?: string;
  /**
   * Public Node.js image the program layer is added to. Alchemy imports
   * it into the app's registry, so the image is pulled from there.
   * @default "mcr.microsoft.com/azurelinux/base/nodejs:24"
   */
  baseImage?: string;
  /** @internal Set automatically by Alchemy when `main` is set. */
  registry?: ContainerAppRegistry;
}

export interface ContainerAppAttributes {
  /** Name of the container app. */
  containerAppName: string;
  /** ARM resource ID of the app; use it as a role-assignment scope. */
  containerAppId: string;
  /** Resource group that holds the app. */
  resourceGroup: string;
  /** Location of the app. */
  location: string;
  /** ARM ID of the environment the app runs in. */
  environmentId: string;
  /** Ingress FQDN, when ingress is enabled. */
  fqdn: string | undefined;
  /** `https://{fqdn}`, when ingress is enabled. */
  url: string | undefined;
  /** Name of the latest revision. */
  latestRevisionName: string | undefined;
  /** Name of the latest revision that is ready. */
  latestReadyRevisionName: string | undefined;
  /** Outbound IP addresses of the app. */
  outboundIpAddresses: string[];
  /** ID to put in the `asuid` TXT record when binding a custom domain. */
  customDomainVerificationId: string | undefined;
  /** Principal ID of the system-assigned identity, if enabled. */
  principalId: string | undefined;
  /** User tags (Alchemy ownership tags stripped). */
  tags: Record<string, string>;
  /** Hash of the bundled program (apps with `main`). */
  codeHash: string | undefined;
  /** Program image Alchemy pushed (apps with `main`). */
  image: string | undefined;
}

export interface ContainerApp<
  Env extends Record<string, any> = Record<string, any>,
> extends Resource<
  ContainerAppTypeId,
  ContainerAppProps<Env>,
  ContainerAppAttributes,
  ContainerAppBinding,
  Providers
> {}

export type ContainerAppServices = Credentials | ServerHost;
export type ContainerAppShape = Main<ContainerAppServices>;

/** Runtime context of a Container App: `serve` for `fetch`, `run` for loops. */
export interface ContainerAppRuntimeContext extends HostRuntimeContext {}

const transformContainerAppProps = (id: string, props: ContainerAppProps) =>
  Effect.gen(function* () {
    // Composition is a deploy concern; inside the bundle props are final.
    if (globalThis.__ALCHEMY_RUNTIME__) return props;
    const resourceGroup = props.resourceGroup ?? (yield* stackResourceGroup).name;
    if (props.main === undefined || props.registry !== undefined) {
      return { ...props, resourceGroup };
    }
    const registry = yield* Effect.gen(function* () {
      const registry = yield* Registry("Registry", {
        resourceGroup,
        location: props.location,
        sku: "Basic",
      });
      // Pull-only token over the registry's built-in `_repositories_pull` scope map.
      const token = yield* Token("PullToken", {
        resourceGroup,
        registry: registry.registryName,
        scopeMapId: Output.interpolate`${registry.registryId}/scopeMaps/_repositories_pull`,
        passwords: [{ name: "password1" }],
      });
      return {
        registryName: registry.registryName,
        resourceGroup,
        loginServer: registry.loginServer,
        tokenName: token.tokenName,
        tokenPassword: token.passwords.pipe(Output.map((passwords) => passwords[0]?.value)),
      };
    }).pipe(Namespace.push(id));
    return { ...props, resourceGroup, registry };
  });

/**
 * An Azure Container App (`Microsoft.App/containerApps`): a serverless
 * container service with revisions, HTTP ingress, KEDA scaling, and
 * scale-to-zero, hosted in a `ManagedEnvironment`.
 *
 * Use it two ways:
 *
 * - **As a runtime** (`main`): Alchemy bundles a Node.js program, pushes it
 *   as one image layer on a public Node.js base image to an Azure Container
 *   Registry it creates (no Docker needed), and runs it with a
 *   system-assigned managed identity. Bindings grant that identity roles.
 * - **With your own images** (`template`): any containers, registries,
 *   scale rules, and volumes.
 *
 * Deploys block until the latest revision is ready.
 *
 * :::caution[Changing `name`, `resourceGroup`, `location`, `environmentId`, `kind`, or `customLocationId` replaces the app]
 * A new app is created, and the old one is deleted.
 * :::
 *
 * :::note[Environment]
 * A runtime app needs a Workload Profiles or Consumption-only environment:
 * `Express` environments have no system-assigned identity and no KEDA
 * scalers. A new environment takes up to 30 minutes to create, so share
 * one across apps.
 * :::
 *
 * :::caution[The app scales to zero]
 * Azure's default minimum is 0 replicas. With no replica running, the
 * first request waits for a cold start (image pull and program init), and
 * background `run` loops stop. Set `template.scale.minReplicas: 1` to keep
 * one replica warm (billed while idle). Event sources wake the app through
 * their KEDA rules, and `appSchedule` keeps one replica running.
 * :::
 *
 * @see https://learn.microsoft.com/azure/container-apps/overview
 *
 * ### Effect Container Apps
 * A Container App with `main` is a class. Props describe the app, and the
 * Effect is the program. `main: import.meta.url` makes the file both the
 * bundle entry and the program. Init binds resources and registers event
 * sources; the returned `fetch` serves every request on `PORT`.
 *
 * **Example:** Effect Container App with an HTTP handler
 * ```typescript
 * // src/api.ts
 * import * as Azure from "@alchemy.run/azure";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Environment } from "./environment.ts";
 *
 * export default class Api extends Azure.ContainerApps.ContainerApp<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const env = yield* Environment;
 *     return { main: import.meta.url, environmentId: env.environmentId };
 *   }),
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello from Container Apps")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * **Example:** The shared environment
 * ```typescript
 * // src/environment.ts
 * export const Environment = Azure.ContainerApps.ManagedEnvironment("Env", {
 *   workloadProfiles: [{ name: "Consumption", workloadProfileType: "Consumption" }],
 * });
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
 * ### Async Container Apps
 * You don't have to use Effect. Call the Container App with `main` pointing
 * at a plain handler file and no implementation. Alchemy bundles that file
 * as-is (no Effect runtime in it) and serves its `fetch` with Node's HTTP
 * server. The `env` prop takes literals, `Config` values, and resources,
 * and {@link InferEnv} types the handler's `env` argument.
 *
 * **Example:** Declaring an async Container App
 * ```typescript
 * // alchemy.run.ts
 * export const Hello = Effect.gen(function* () {
 *   const env = yield* Environment;
 *   return yield* Azure.ContainerApps.ContainerApp("Hello", {
 *     main: "./src/hello.ts",
 *     environmentId: env.environmentId,
 *     env: {
 *       GREETING: "hello",
 *       API_KEY: Config.redacted("API_KEY"),
 *       UPLOADS: uploads,
 *     },
 *   });
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
 * **Example:** Size, port, base image, and tags
 * ```typescript
 * export default class Api extends Azure.ContainerApps.ContainerApp<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const env = yield* Environment;
 *     return {
 *       main: import.meta.url,
 *       environmentId: env.environmentId,
 *       cpu: 1,
 *       memory: "2Gi",
 *       port: 3000,
 *       baseImage: "mcr.microsoft.com/azurelinux/base/nodejs:20",
 *       tags: { team: "web" },
 *     };
 *   }),
 *   program,
 * ) {}
 * ```
 *
 * **Example:** Internal ingress only
 * ```typescript
 * const props = {
 *   main: import.meta.url,
 *   environmentId: env.environmentId,
 *   configuration: { ingress: { external: false, targetPort: 8080 } },
 * };
 * ```
 *
 * ### Scaling
 * HTTP traffic scales the app from zero by default. Set the replica range
 * and extra KEDA rules on `template.scale`; event sources add their own
 * rules.
 *
 * **Example:** Keep one replica warm, scale to ten
 * ```typescript
 * const props = {
 *   main: import.meta.url,
 *   environmentId: env.environmentId,
 *   template: { scale: { minReplicas: 1, maxReplicas: 10 } },
 * };
 * ```
 *
 * **Example:** Scale on a KEDA cron window
 * ```typescript
 * const props = {
 *   main: import.meta.url,
 *   environmentId: env.environmentId,
 *   template: {
 *     scale: {
 *       minReplicas: 0,
 *       maxReplicas: 3,
 *       rules: [
 *         {
 *           name: "business-hours",
 *           custom: {
 *             type: "cron",
 *             metadata: {
 *               timezone: "Europe/Berlin",
 *               start: "0 8 * * 1-5",
 *               end: "0 18 * * 1-5",
 *               desiredReplicas: "2",
 *             },
 *           },
 *         },
 *       ],
 *     },
 *   },
 * };
 * ```
 *
 * ### Networking
 * Put the environment in your virtual network to reach private endpoints,
 * and set `internal: true` to serve apps on the virtual network only. The
 * infrastructure subnet is delegated to `Microsoft.App/environments` and
 * needs at least a `/27` for a Workload Profiles environment. The
 * environment's network settings cannot change after creation.
 *
 * **Example:** Environment in a virtual network
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const infra = yield* Azure.Network.Subnet("AppsInfra", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.0.0/23",
 *   delegations: [{ serviceName: "Microsoft.App/environments" }],
 * });
 * const env = yield* Azure.ContainerApps.ManagedEnvironment("Env", {
 *   workloadProfiles: [{ name: "Consumption", workloadProfileType: "Consumption" }],
 *   vnetConfiguration: { infrastructureSubnetId: infra.subnetId, internal: true },
 * });
 * ```
 *
 * **Example:** Allow one IP range on public ingress
 * ```typescript
 * const props = {
 *   main: import.meta.url,
 *   environmentId: env.environmentId,
 *   configuration: {
 *     ingress: {
 *       external: true,
 *       targetPort: 8080,
 *       ipSecurityRestrictions: [
 *         { name: "office", ipAddressRange: "203.0.113.0/24", action: "Allow" },
 *       ],
 *     },
 *   },
 * };
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
 * **Example:** Read a Key Vault secret
 * ```typescript
 * // init
 * const apiKey = yield* Azure.KeyVault.SecretRead(apiKeySecret);
 *
 * // runtime: the latest version, as a Redacted<string>
 * const value = yield* apiKey.get();
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
 * **Example:** Send a batch of events
 * ```typescript
 * // init
 * const readings = yield* Azure.EventHub.Send(hub);
 *
 * // runtime
 * yield* readings.sendBatch([{ deviceId: "d1" }, { deviceId: "d2" }]);
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
 * `StartContainerApp`, `StopContainerApp`, and `RestartContainerAppRevision`
 * let another runtime operate the app. Each grants a custom role with only
 * its one action, on this app only.
 *
 * **Example:** Stop the app from a Function
 * ```typescript
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const api = yield* Api;
 *     // init
 *     const stop = yield* Azure.ContainerApps.StopContainerApp(api);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         yield* stop();
 *         return HttpServerResponse.text("accepted");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ContainerApps.StopContainerAppHttp)),
 * ) {}
 * ```
 *
 * ### Event Sources
 * Each event source adds a KEDA scale rule (authenticated with the app's
 * identity), grants the roles it needs, and runs a consumer loop in every
 * replica. The contract lives in the source's service; provide the
 * Container Apps layer.
 *
 * **Example:** Consume a Storage queue
 * ```typescript
 * yield* Azure.Storage.consumeQueueMessages(jobs, (message) =>
 *   Effect.log(message.body),
 * );
 * // …provided with Effect.provide(Azure.ContainerApps.AppStorageQueueEventSource)
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
 * // …provided with Azure.ContainerApps.AppServiceBusQueueEventSource and
 * // Azure.ContainerApps.AppServiceBusSubscriptionEventSource
 * ```
 *
 * **Example:** Run on a cron schedule
 * ```typescript
 * yield* Azure.ContainerApps.appSchedule("nightly", "0 3 * * *", (run) =>
 *   Effect.log(`nightly job due at ${run.scheduledTime}`),
 * );
 * ```
 *
 * ### Bring Your Own Image
 * Without `main`, describe the containers yourself.
 *
 * **Example:** Public HTTP app that scales to zero
 * ```typescript
 * const env = yield* Azure.ContainerApps.ManagedEnvironment("env");
 * const api = yield* Azure.ContainerApps.ContainerApp("api", {
 *   environmentId: env.environmentId,
 *   configuration: { ingress: { external: true, targetPort: 80 } },
 *   template: {
 *     containers: [
 *       {
 *         name: "api",
 *         image: "mcr.microsoft.com/k8se/quickstart:latest",
 *         resources: { cpu: 0.25, memory: "0.5Gi" },
 *       },
 *     ],
 *     scale: { minReplicas: 0, maxReplicas: 1 },
 *   },
 * });
 * ```
 *
 * **Example:** Reference a secret from an env var
 * ```typescript
 * const api = yield* Azure.ContainerApps.ContainerApp("api", {
 *   environmentId: env.environmentId,
 *   secrets: [{ name: "db-password", value: Redacted.make(password) }],
 *   template: {
 *     containers: [
 *       {
 *         name: "api",
 *         image: "mcr.microsoft.com/k8se/quickstart:latest",
 *         env: [
 *           { name: "MODE", value: "production" },
 *           { name: "DB_PASSWORD", secretRef: "db-password" },
 *         ],
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * **Example:** System-assigned identity
 * ```typescript
 * const api = yield* Azure.ContainerApps.ContainerApp("api", {
 *   environmentId: env.environmentId,
 *   identity: { type: "SystemAssigned" },
 *   template: { containers: [{ name: "api", image }] },
 * });
 * // api.principalId can now be granted roles
 * ```
 *
 * @resource
 * @category ContainerApps
 */
export const ContainerApp: Platform<
  ContainerApp,
  ContainerAppServices,
  ContainerAppShape,
  ContainerAppRuntimeContext,
  {},
  ContainerAppProps
> & {
  /**
   * Async (no-impl) constructor: captures the `env` literal so
   * {@link InferEnv} types the handler's `env` argument.
   */
  <const Env extends Record<string, any>, PropsReq = never>(
    id: string,
    props:
      | InputProps<ContainerAppProps<Env>>
      | Effect.Effect<InputProps<ContainerAppProps<Env>>, never, PropsReq>,
  ): Effect.Effect<ContainerApp<Env>, never, Providers | PropsReq>;
} = Platform(ContainerAppTypeId, {
  createRuntimeContext: createContainerRuntimeContext(ContainerAppTypeId) as (
    id: string,
  ) => ContainerAppRuntimeContext,
  transformProps: (id, props) => transformContainerAppProps(id, props),
});

export class ContainerAppTemplateMissing extends Data.TaggedError(
  "Azure.ContainerApps.ContainerAppTemplateMissing",
)<{ message: string }> {}

export class ContainerAppRegistryMissing extends Data.TaggedError(
  "Azure.ContainerApps.ContainerAppRegistryMissing",
)<{ message: string }> {}

/** Name of the program's container. */
const PROGRAM_CONTAINER = "main";
/** Secret holding the registry pull token's password. */
const REGISTRY_SECRET = "alchemy-registry";

const PACKAGE_JSON = new TextEncoder().encode(
  `${JSON.stringify({ type: "module", main: "index.mjs" }, null, 2)}\n`,
);

/** Generated entry of an Effect app: raise the runtime flag, run the program. */
const effectEntry = (handler: string) => (importPath: string) =>
  `
import { bootstrap } from "@alchemy.run/azure/Bootstrap/ContainerApp";

globalThis.__ALCHEMY_RUNTIME__ = true;
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});

await bootstrap(entrypoint);
`;

/** Generated entry of an async app: no Effect, just the handler file. */
const asyncEntry = (handler: string, envKeys: readonly string[]) => (importPath: string) =>
  `
import { serve } from "@alchemy.run/azure/Bootstrap/ContainerAppAsync";
import { ${handler} as handler } from ${JSON.stringify(importPath)};

serve(handler, ${JSON.stringify(envKeys)});
`;

const makeBundler = Effect.gen(function* () {
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
  return Effect.fn(function* (props: ContainerAppProps & { main: string }) {
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
      envKeys: props.isExternal ? envKeys : [],
      baseImage: props.baseImage ?? DEFAULT_BASE_IMAGE,
    })).slice(0, 16);
    return { files, codeHash };
  });
});

const createAppName = (id: string) => createContainerAppsName(id, 32);

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: app.GetContainerAppResponse,
  program?: { codeHash: string | undefined; image: string | undefined },
): ContainerAppAttributes => {
  const props = observed.properties;
  const fqdn = props?.configuration?.ingress?.fqdn;
  return {
    containerAppName: name,
    containerAppId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    environmentId: props?.managedEnvironmentId ?? props?.environmentId ?? "",
    fqdn,
    url: fqdn ? `https://${fqdn}` : undefined,
    latestRevisionName: props?.latestRevisionName,
    latestReadyRevisionName: props?.latestReadyRevisionName,
    outboundIpAddresses: [...(props?.outboundIpAddresses ?? [])],
    customDomainVerificationId: props?.customDomainVerificationId,
    principalId: observed.identity?.principalId,
    tags: userTags(observed.tags),
    codeHash: program?.codeHash,
    image: program?.image,
  };
};

/** Bindings a deploy keeps (bindings being removed are excluded), merged. */
const collectBindings = (bindings: ReadonlyArray<ResourceBinding<ContainerAppBinding>>) => {
  const env: Record<string, unknown> = {};
  const grants = new Map<string, HostRoleAssignment>();
  const scaleRules = new Map<string, ContainerAppScaleRule>();
  let minReplicas: number | undefined;
  const active = bindings.filter(
    (b: ResourceBinding<ContainerAppBinding> & { action?: string }) => b.action !== "delete",
  );
  for (const binding of active) {
    Object.assign(env, binding.data?.env ?? {});
    for (const grant of binding.data?.roleAssignments ?? []) {
      grants.set(`${grant.scope.toLowerCase()}|${grant.roleDefinitionId.toLowerCase()}`, grant);
    }
    for (const rule of binding.data?.scaleRules ?? []) {
      scaleRules.set(rule.name ?? "", rule);
    }
    if (binding.data?.minReplicas !== undefined) {
      minReplicas = Math.max(minReplicas ?? 0, binding.data.minReplicas);
    }
  }
  return {
    env,
    grants: [...grants.values()],
    scaleRules: [...scaleRules.values()],
    minReplicas,
  };
};

type CollectedBindings = ReturnType<typeof collectBindings>;

/** Container Apps secret names: lowercase letters, digits, and `-`. */
const envSecretName = (key: string) =>
  `env-${key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`.slice(0, 253);

/**
 * Env vars for `env`: strings as they are, other values packed as the
 * runtime unpacks them, and `Redacted` values (packed) through a secret.
 */
const toEnvVars = (env: Record<string, unknown>) => {
  const vars: app.EnvironmentVar[] = [];
  const secrets: ContainerAppsSecret[] = [];
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (value === undefined) continue;
    const packed = typeof value === "string" ? value : packEnvValueKeepRedacted(value);
    if (Redacted.isRedacted(packed)) {
      const name = envSecretName(key);
      secrets.push({ name, value: packed });
      vars.push({ name: key, secretRef: name });
    } else {
      vars.push({ name: key, value: packed });
    }
  }
  return { vars, secrets };
};

/** Add `vars` to `env`; a name the container already sets wins. */
const mergeEnv = (
  own: ReadonlyArray<app.EnvironmentVar> | undefined,
  vars: ReadonlyArray<app.EnvironmentVar>,
) => {
  const taken = new Set((own ?? []).map((e) => e.name));
  return [...(own ?? []), ...vars.filter((v) => !taken.has(v.name))];
};

interface DesiredContext {
  stack: { name: string; stage: string };
  bindings: CollectedBindings;
  /** The program image (apps with `main`). */
  image: string | undefined;
}

/** The desired `properties` body (secret values revealed) and its secrets. */
const toDesired = (props: ContainerAppProps, ctx: DesiredContext) => {
  const userTemplate = props.template ?? {};
  const port = props.port ?? 8080;
  let containers: app.Container[];
  let configuration: ContainerAppConfiguration = { ...props.configuration };
  const secrets: ContainerAppsSecret[] = [...(props.secrets ?? [])];

  if (props.main !== undefined) {
    const env = toEnvVars({
      ALCHEMY_STACK_NAME: ctx.stack.name,
      ALCHEMY_STAGE: ctx.stack.stage,
      ALCHEMY_PHASE: "runtime",
      PORT: String(port),
      ...ctx.bindings.env,
      ...props.env,
    });
    secrets.push(...env.secrets);
    containers = [
      {
        name: PROGRAM_CONTAINER,
        image: ctx.image,
        resources: { cpu: props.cpu ?? 0.5, memory: props.memory ?? "1Gi" },
        env: env.vars,
      },
      ...(userTemplate.containers ?? []).filter((c) => c.name !== PROGRAM_CONTAINER),
    ];
    configuration = {
      ...configuration,
      ingress: configuration.ingress ?? { external: true, targetPort: port },
    };
    const registry = props.registry;
    if (registry !== undefined) {
      if (registry.tokenPassword !== undefined) {
        secrets.push({ name: REGISTRY_SECRET, value: registry.tokenPassword });
      }
      configuration = {
        ...configuration,
        registries: [
          ...(configuration.registries ?? []).filter(
            (r) => lower(r.server) !== lower(registry.loginServer),
          ),
          {
            server: registry.loginServer,
            username: registry.tokenName,
            passwordSecretRef: REGISTRY_SECRET,
          },
        ],
      };
    }
  } else {
    // Bring-your-own-image apps: binding env goes to every container.
    const env = toEnvVars(ctx.bindings.env);
    secrets.push(...env.secrets);
    containers = (userTemplate.containers ?? []).map((container) =>
      env.vars.length === 0 ? container : { ...container, env: mergeEnv(container.env, env.vars) },
    );
  }

  const scale = userTemplate.scale;
  const userRules = scale?.rules ?? [];
  const rules = [
    ...userRules,
    ...ctx.bindings.scaleRules.filter((r) => !userRules.some((u) => u.name === r.name)),
  ];
  const minReplicas =
    ctx.bindings.minReplicas === undefined
      ? scale?.minReplicas
      : Math.max(scale?.minReplicas ?? 0, ctx.bindings.minReplicas);
  const template: ContainerAppTemplate = {
    ...userTemplate,
    containers,
    scale:
      scale === undefined && rules.length === 0 && minReplicas === undefined
        ? undefined
        : { ...scale, minReplicas, rules: rules.length > 0 ? rules : scale?.rules },
  };
  const wireSecrets = toSecrets(secrets);
  const properties: app.ContainerAppPropertiesInput = {
    managedEnvironmentId: props.environmentId,
    workloadProfileName: props.workloadProfileName,
    configuration: { ...configuration, secrets: wireSecrets },
    template,
  };
  return { properties, configuration, secrets: wireSecrets };
};

/**
 * The observed properties with registry `passwordSecretRef`s as plain
 * names: the SDK marks them sensitive, but they only name a secret.
 */
const withPlainSecretRefs = (properties: app.GetContainerAppResponse["properties"]) => {
  const registries = properties?.configuration?.registries;
  // ARM answers `null` for an app without registries.
  return !Array.isArray(registries) || properties?.configuration === undefined
    ? properties
    : {
        ...properties,
        configuration: {
          ...properties.configuration,
          registries: registries.map((registry) => ({
            ...registry,
            passwordSecretRef: reveal(registry.passwordSecretRef),
          })),
        },
      };
};

/** Identity with SystemAssigned enabled, as runtimes and binding grants need it. */
const withSystemIdentity = (identity: ContainerAppsIdentity | undefined): ContainerAppsIdentity => {
  switch (identity?.type) {
    case undefined:
    case "None":
      return { type: "SystemAssigned" };
    case "UserAssigned":
      return { ...identity, type: "SystemAssigned,UserAssigned" };
    default:
      return identity ?? { type: "SystemAssigned" };
  }
};

/** Deterministic assignment name: one per (app, scope, role). */
const bindingAssignmentName = (appId: string, scope: string, role: string) =>
  Effect.sync(() => {
    const hex = createHash("sha256")
      .update(`${appId.toLowerCase()}|${normalizeScope(scope)}|${role.toLowerCase()}`)
      .digest("hex");
    const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  });

const roleGuid = (roleDefinitionId: string) =>
  (roleDefinitionId.split("/").pop() ?? roleDefinitionId).toLowerCase();

/** Binding-created role assignments currently held by `principalId`. */
const listBindingAssignments = (subscriptionId: string, principalId: string, marker: string) =>
  collectAll(authorization.ListRoleAssignmentForSubscription, {
    subscriptionId,
    _filter: `principalId eq '${principalId}'`,
  }).pipe(
    Effect.map((page) =>
      page.value.filter((a) => (a.properties?.description ?? "").endsWith(marker)),
    ),
  );

/** Binding marker; distinct from `RoleAssignment`'s so `list` ignores it. */
const bindingMarker = (id: string) => ownershipMarker(`${id}#binding`);

/**
 * Converge the app identity's role assignments to exactly the binding
 * grants: create missing ones, delete binding-created ones no longer wanted.
 */
export const syncBindingAssignments = Effect.fn(function* (options: {
  id: string;
  subscriptionId: string;
  appId: string;
  principalId: string;
  grants: ReadonlyArray<{ roleDefinitionId: string; scope: string }>;
}) {
  const marker = yield* bindingMarker(options.id);
  const observed = yield* listBindingAssignments(
    options.subscriptionId,
    options.principalId,
    marker,
  );
  const desired = new Map<string, { roleDefinitionId: string; scope: string }>();
  for (const grant of options.grants) {
    const name = yield* bindingAssignmentName(
      options.appId,
      grant.scope,
      roleGuid(grant.roleDefinitionId),
    );
    desired.set(name, grant);
  }
  const observedNames = new Set(observed.map((a) => a.name));
  for (const [name, grant] of desired) {
    if (observedNames.has(name)) continue;
    yield* authorization
      .CreateRoleAssignment({
        scope: grant.scope,
        roleAssignmentName: name,
        properties: {
          roleDefinitionId: roleDefinitionIdOf(options.subscriptionId, grant.roleDefinitionId),
          principalId: options.principalId,
          principalType: "ServicePrincipal",
          description: descriptionWithMarker("Alchemy binding", marker),
        },
      })
      .pipe(
        // A fresh system identity takes a moment to replicate through Entra ID.
        Effect.retry({
          while: (e) => e._tag === "PrincipalNotFound",
          schedule: Schedule.spaced("5 seconds"),
          times: 12,
        }),
        Effect.catchTag("RoleAssignmentExists", () => Effect.void),
      );
  }
  for (const stale of observed) {
    if (stale.name === undefined || desired.has(stale.name)) continue;
    const scope = stale.properties?.scope;
    if (scope === undefined) continue;
    yield* ignoreNotFound(
      authorization.DeleteRoleAssignment({
        scope,
        roleAssignmentName: stale.name,
      }),
    );
  }
});

/**
 * Ready once provisioning succeeded and the latest revision is ready, so
 * callers can route traffic as soon as the deploy returns. Express
 * environments never report a ready revision; their single revision is
 * ready when provisioning succeeds.
 */
const appState = (observed: app.GetContainerAppResponse) => {
  const props = observed.properties;
  const state = props?.provisioningState ?? "InProgress";
  if (state !== "Succeeded") return state;
  return props?.latestReadyRevisionName !== undefined &&
    props.latestReadyRevisionName !== props.latestRevisionName
    ? "RevisionProvisioning"
    : "Succeeded";
};

export const ContainerAppProvider = () =>
  Provider.effect(
    ContainerApp,
    Effect.gen(function* () {
      const bundle = yield* makeBundler;

      return ContainerApp.Provider.of({
        stables: [
          "containerAppName",
          "containerAppId",
          "resourceGroup",
          "location",
          "customDomainVerificationId",
        ],

        nuke: {
          dependsOn: ["Azure.ContainerApps.ManagedEnvironment", "Azure.Resources.ResourceGroup"],
        },

        list: Effect.fn(function* () {
          const { subscriptionId } = yield* AzureEnvironment.current;
          const page = yield* collectAll(app.ListContainerAppBySubscription, { subscriptionId });
          return (page.value ?? []).flatMap((observed) => {
            const group = resourceGroupOf(observed.id);
            return hasAnyAlchemyTag(observed.tags) &&
              group !== undefined &&
              observed.name !== undefined
              ? [toAttrs(group, observed.name, observed)]
              : [];
          });
        }),

        diff: Effect.fn(function* ({ news, olds, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          const props = news as ContainerAppProps;
          if (
            (props.resourceGroup !== undefined &&
              lower(props.resourceGroup) !== lower(output.resourceGroup)) ||
            (olds !== undefined && lower(props.kind) !== lower(olds.kind)) ||
            (olds !== undefined &&
              lower(props.customLocationId) !== lower(olds.customLocationId)) ||
            (props.name !== undefined && props.name !== output.containerAppName) ||
            (props.location !== undefined && !sameLocation(props.location, output.location)) ||
            lower(props.environmentId) !== lower(output.environmentId)
          ) {
            return { action: "replace" } as const;
          }
          // A code-only change leaves the props untouched: compare bundles.
          if (props.main !== undefined) {
            const { codeHash } = yield* bundle({ ...props, main: props.main });
            if (codeHash !== output.codeHash) return { action: "update" } as const;
          }
          return undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { subscriptionId } = yield* AzureEnvironment.current;
          const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
          if (resourceGroup === undefined) return undefined;
          const name = output?.containerAppName ?? olds?.name ?? (yield* createAppName(id));
          const observed = yield* getContainerApp(subscriptionId, resourceGroup, name);
          if (observed === undefined) return undefined;
          const attrs = toAttrs(resourceGroup, name, observed, output);
          return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, olds, output, bindings }) {
          const env = yield* AzureEnvironment.current;
          const { subscriptionId } = env;
          const stack = yield* Stack;
          yield* ensureRegistered(subscriptionId, "Microsoft.App");
          const resourceGroup = news.resourceGroup;
          if (resourceGroup === undefined) {
            return yield* new ContainerAppTemplateMissing({
              message: `Azure.ContainerApps.ContainerApp "${id}" has no resource group`,
            });
          }
          if (news.main === undefined && news.template === undefined) {
            return yield* new ContainerAppTemplateMissing({
              message: `Azure.ContainerApps.ContainerApp "${id}" needs \`main\` or \`template\``,
            });
          }
          const name = news.name ?? output?.containerAppName ?? (yield* createAppName(id));
          const location = news.location ?? output?.location ?? env.location;
          const tags = yield* desiredTags(id, news.tags);
          const collected = collectBindings(bindings as ResourceBinding<ContainerAppBinding>[]);

          // Build and push the program image (skipped when its tag exists).
          let program: { codeHash: string | undefined; image: string | undefined } = {
            codeHash: undefined,
            image: undefined,
          };
          if (news.main !== undefined) {
            const registry = news.registry;
            if (registry === undefined) {
              return yield* new ContainerAppRegistryMissing({
                message: `Azure.ContainerApps.ContainerApp "${id}" has no container registry`,
              });
            }
            const { files, codeHash } = yield* bundle({ ...news, main: news.main });
            const image = yield* pushProgramImage({
              subscriptionId,
              resourceGroup: registry.resourceGroup,
              registryName: registry.registryName,
              loginServer: registry.loginServer,
              repository: name,
              tag: codeHash,
              baseImage: news.baseImage ?? DEFAULT_BASE_IMAGE,
              files,
              entrypoint: [`${APP_DIR}/index.mjs`],
            });
            program = { codeHash, image };
          }

          const ctx = { stack, bindings: collected, image: program.image };
          const desired = toDesired(news, ctx);
          const identity =
            news.main !== undefined || collected.grants.length > 0
              ? withSystemIdentity(news.identity)
              : news.identity;
          const where = {
            subscriptionId,
            resourceGroupName: resourceGroup,
            containerAppName: name,
          };
          const get = getContainerApp(subscriptionId, resourceGroup, name);
          const put = app.ContainerAppsCreateOrUpdate({
            ...where,
            location,
            tags,
            identity: toIdentity(identity),
            kind: news.kind,
            extendedLocation:
              news.customLocationId === undefined
                ? undefined
                : { name: news.customLocationId, type: "CustomLocation" },
            properties: desired.properties,
          });
          const ready = waitForProvisioned(`container app ${name}`, get, appState, {
            interval: "5 seconds",
            times: 60,
          });

          // Observe.
          let observed = yield* get;

          // Ensure. The PUT carries the full desired state.
          if (observed === undefined) {
            yield* put;
            observed = yield* ready;
          } else {
            // Wait out an in-flight operation before comparing.
            observed = yield* ready;
            // Sync. ARM echoes defaults back, so compare the desired subset;
            // secret values are only observable through `listSecrets`, and
            // removed properties only against the previous props.
            const observedSecrets =
              desired.secrets.length > 0 ||
              (observed.properties?.configuration?.secrets ?? []).length > 0
                ? (yield* orUndefinedIfNotFound(app.ListContainerAppSecrets(where)))?.value
                : [];
            const inSync =
              matchesDesired(
                { ...desired.properties, configuration: desired.configuration },
                withPlainSecretRefs(observed.properties),
              ) &&
              secretsMatch(desired.secrets, observedSecrets) &&
              identityMatches(identity, observed.identity) &&
              !tagsDiffer(observed.tags, tags) &&
              (olds === undefined ||
                fingerprint(desired.properties) === fingerprint(toDesired(olds, ctx).properties));
            if (!inSync) {
              yield* put;
              observed = yield* ready;
            }
          }

          // Sync binding role grants against the identity's observed
          // assignments; also prunes grants of bindings that were removed.
          const principalId = observed.identity?.principalId;
          if (principalId !== undefined && observed.id !== undefined) {
            yield* syncBindingAssignments({
              id,
              subscriptionId,
              appId: observed.id,
              principalId,
              grants: collected.grants,
            });
          }

          return toAttrs(resourceGroup, name, observed, program);
        }),

        delete: Effect.fn(function* ({ id, output }) {
          const { subscriptionId } = yield* AzureEnvironment.current;
          // Role assignments outlive their principal; remove binding grants first.
          if (output.principalId !== undefined) {
            yield* syncBindingAssignments({
              id,
              subscriptionId,
              appId: output.containerAppId,
              principalId: output.principalId,
              grants: [],
            });
          }
          yield* ignoreNotFound(
            app.DeleteContainerApp({
              subscriptionId,
              resourceGroupName: output.resourceGroup,
              containerAppName: output.containerAppName,
            }),
          );
          yield* waitUntilGone(
            `container app ${output.containerAppName}`,
            getContainerApp(subscriptionId, output.resourceGroup, output.containerAppName),
            { interval: "5 seconds", times: 60 },
          );
        }),
      });
    }),
  );
