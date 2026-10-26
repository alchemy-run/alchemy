import * as zlib from "node:zlib";
import type { Credentials } from "@distilled.cloud/azure";
import * as aci from "@distilled.cloud/azure/containerinstance";
import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import * as acr from "@distilled.cloud/azure/containerregistry-data";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Bundle from "alchemy/Bundle/Bundle";
import { findCwdForBundle, resolveMainPath } from "alchemy/Bundle/TempRoot";
import { isResolved } from "alchemy/Diff";
import type { InputProps } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import { Platform, type Main, type PlatformProps, type PlatformServices } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource, ResourceBinding } from "alchemy/Resource";
import {
  createContainerRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "alchemy/Runtime/Process";
import { packEnvValue, unpackEnvValue, type RuntimeContext } from "alchemy/RuntimeContext";
import { Stack } from "alchemy/Stack";
import { sha256, sha256Object } from "alchemy/Util/sha256";
import { tarGzipDirectory } from "alchemy/Util/tarGzip";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { Scope } from "effect/Scope";
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
import { managedIdentityHostBundle } from "../AzureBindings.ts";
import { syncBindingAssignments } from "../ContainerApps/ContainerApp.ts";
import { Registry } from "../ContainerRegistry/Registry.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { stackResourceGroup } from "../StackResourceGroup.ts";
import {
  comparable,
  createContainerInstanceName,
  fingerprint,
  identityMatches,
  lower,
  matchesDesired,
  sameLocation,
  toContainers,
  toDiagnostics,
  toIdentity,
  toRegistryCredentials,
  type ContainerInstanceContainer,
  type ContainerInstanceIdentity,
  type ContainerInstanceIpAddress,
  type ContainerInstanceLogAnalytics,
  type ContainerInstanceRegistryCredential,
} from "./common.ts";

export type {
  ContainerInstanceContainer,
  ContainerInstanceIdentity,
  ContainerInstanceIpAddress,
  ContainerInstanceLogAnalytics,
  ContainerInstanceRegistryCredential,
} from "./common.ts";

export const ContainerGroupTypeId = "Azure.ContainerInstance.ContainerGroup" as const;
export type ContainerGroupTypeId = typeof ContainerGroupTypeId;

/** A role the group's managed identity holds on one scope. */
export interface ContainerGroupRoleAssignment {
  /** Built-in role GUID or full role-definition ARM ID. */
  roleDefinitionId: string;
  /** ARM ID the role is granted on: the bound resource, never wider. */
  scope: string;
}

/**
 * Binding contract accepted by `Azure.ContainerInstance.ContainerGroup`
 * (the Azure `HostBinding` shape):
 *
 * - `roleAssignments` are granted to the group's system-assigned identity;
 *   the ones a deploy no longer asks for are revoked (only ones it made).
 * - `env` becomes environment variables of the program's container.
 */
export interface ContainerGroupBinding {
  roleAssignments?: ContainerGroupRoleAssignment[];
  env?: Record<string, unknown>;
}

/**
 * The registry Alchemy pushes a program's image to. Set automatically.
 * @internal
 */
export interface ContainerGroupHosting {
  registryName: string;
  loginServer: string;
  resourceGroup: string;
}

export interface ContainerGroupProps<
  Env extends Record<string, any> = Record<string, any>,
> extends PlatformProps {
  /**
   * Resource group the container group is created in. Changing it replaces
   * the group.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup?: string;
  /**
   * Container group name: 1-63 lowercase letters, digits, and hyphens. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the group.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the group.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Availability zones to pin the group to. Changing them replaces the group. */
  zones?: string[];
  /**
   * Operating system of the containers. A program (`main`) runs on Linux.
   * Changing it replaces the group.
   * @default "Linux"
   */
  osType?: "Linux" | "Windows";
  /**
   * SKU. `Confidential` runs in a confidential-computing enclave and
   * `Dedicated` on dedicated hosts; neither is available on every
   * subscription. Changing it replaces the group.
   * @default Azure's default (`Standard`)
   */
  sku?: "Standard" | "Dedicated" | "Confidential";
  /**
   * Entry module of a program Alchemy bundles and runs in the group. For an
   * Effect program this is `import.meta.url` (the file is both the bundle
   * entry and the program). For an async program it is a handler file that
   * default-exports `{ fetch(request, env) }`. Alchemy bundles it for
   * Node.js into one ESM file, layers it onto {@link baseImage}, and pushes
   * the image to a registry it creates for the group.
   *
   * Without `main`, the group runs `containers` as given.
   */
  main?: string;
  /**
   * Named export of `main` that holds the program or handler.
   * @default "default"
   */
  handler?: string;
  /** Rolldown overrides for the program's bundle. */
  build?: Bundle.BundleConfig;
  /**
   * Environment variables of the program's container. Accepts literals,
   * `Config` values, Outputs, and resources (a resource arrives as its
   * attributes, JSON-encoded). Secrets (`Redacted`) become secure
   * environment variables. Merged after the `env` that bindings contribute.
   *
   * On an async program, `Azure.InferEnv` types the handler's `env`
   * argument from this object.
   */
  env?: Env;
  /**
   * Port the program's HTTP server listens on (`PORT`), opened on the
   * group's public IP.
   * @default 3000
   */
  port?: number;
  /**
   * CPU cores of the program's container (e.g. `0.5`, `1`). Changing it
   * replaces the group.
   * @default 1
   */
  cpu?: number;
  /**
   * Memory of the program's container in GB (e.g. `0.5`, `1.5`). Changing
   * it replaces the group.
   * @default 1.5
   */
  memoryInGB?: number;
  /**
   * Public Linux image with Node.js that the program's bundle is layered
   * onto. It is imported into the group's registry once.
   * @default "mcr.microsoft.com/azurelinux/base/nodejs:24"
   */
  baseImage?: string;
  /**
   * Containers of the group. Required without `main`; with `main` they run
   * as sidecars next to the program's container (`app`). Changing the set
   * of names or their CPU/memory replaces the group.
   */
  containers?: ContainerInstanceContainer[];
  /** Init containers run to completion before the app containers. Changing them replaces the group. */
  initContainers?: aci.InitContainerDefinitionInput[];
  /**
   * Restart policy for all containers. Changing it replaces the group.
   * @default "Always"
   */
  restartPolicy?: "Always" | "OnFailure" | "Never";
  /**
   * Public or private IP address of the group.
   * @default with `main`, a public IP on `port` with the DNS label `name`
   */
  ipAddress?: ContainerInstanceIpAddress;
  /** Credentials for private image registries. */
  imageRegistryCredentials?: ContainerInstanceRegistryCredential[];
  /**
   * Volumes the containers can mount (Azure Files, emptyDir, secret, git
   * repo). Changing them replaces the group.
   */
  volumes?: aci.Volume[];
  /** Send container logs to a Log Analytics workspace. */
  logAnalytics?: ContainerInstanceLogAnalytics;
  /**
   * ARM IDs of subnets (delegated to `Microsoft.ContainerInstance/containerGroups`)
   * to inject the group into. Changing them replaces the group.
   */
  subnetIds?: string[];
  /** DNS configuration of the group. Changing it replaces the group. */
  dnsConfig?: aci.DnsConfiguration;
  /**
   * `Spot` runs on discounted, evictable capacity. Changing it replaces the group.
   * @default "Regular"
   */
  priority?: "Regular" | "Spot";
  /**
   * Managed identity of the group. A program (`main`) always gets a
   * system-assigned identity; user-assigned identities are added to it.
   */
  identity?: ContainerInstanceIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
  /** @internal Set automatically by Alchemy. */
  hosting?: ContainerGroupHosting;
}

export interface ContainerGroupAttributes {
  /** Name of the container group. */
  containerGroupName: string;
  /** ARM resource ID of the group; use it as a role-assignment scope. */
  containerGroupId: string;
  /** Resource group that holds the group. */
  resourceGroup: string;
  /** Location of the group. */
  location: string;
  /** IP address of the group, when it has one. */
  ip: string | undefined;
  /** FQDN of the group, when `ipAddress.dnsNameLabel` is set. */
  fqdn: string | undefined;
  /** `http://<fqdn or ip>:<port>` of the group's first public port, when it has one. */
  url: string | undefined;
  /** Runtime state of the group, e.g. `Running`, `Succeeded`, `Stopped`. */
  state: string | undefined;
  /** Principal ID of the system-assigned identity, if enabled. */
  principalId: string | undefined;
  /** Image of the program's container (`<registry>/app:<codeHash>`), with `main`. */
  image: string | undefined;
  /** Hash of the program's bundle, with `main`. */
  codeHash: string | undefined;
  /** Hash of the deployed spec, secrets included, so a rotated secret re-deploys. */
  specHash: string | undefined;
  /** User tags (Alchemy ownership tags stripped). */
  tags: Record<string, string>;
}

export interface ContainerGroup<
  Env extends Record<string, any> = Record<string, any>,
> extends Resource<
  ContainerGroupTypeId,
  ContainerGroupProps<Env>,
  ContainerGroupAttributes,
  ContainerGroupBinding,
  Providers
> {}

export type ContainerGroupServices = Credentials | ServerHost;

export type ContainerGroupShape =
  | void
  | (Exclude<Main<ContainerGroupServices>, void> & {
      /**
       * A long-running (or one-shot) loop the container runs next to
       * `fetch`. A program with only `run` exits when it completes, and
       * `restartPolicy` decides whether it starts again.
       */
      run?: Effect.Effect<
        void,
        never,
        ContainerGroupServices | PlatformServices | RuntimeContext | Scope
      >;
    });

/** Runtime context of a container group program. */
export interface ContainerGroupRuntimeContext extends HostRuntimeContext {}

const transformContainerGroupProps = (id: string, props: ContainerGroupProps) =>
  Effect.gen(function* () {
    // Composition is a deploy concern; inside the bundle props are final.
    if (globalThis.__ALCHEMY_RUNTIME__) return props;
    const resourceGroup = props.resourceGroup ?? (yield* stackResourceGroup).name;
    if (props.main === undefined) return { ...props, resourceGroup };
    const registry = yield* Registry("Registry", {
      resourceGroup,
      location: props.location,
      sku: "Basic",
      adminUserEnabled: true,
    }).pipe(Namespace.push(id));
    return {
      ...props,
      resourceGroup,
      hosting: {
        registryName: registry.registryName,
        loginServer: registry.loginServer,
        resourceGroup: registry.resourceGroup,
      },
    };
  });

/**
 * An Azure Container Instances container group
 * (`Microsoft.ContainerInstance/containerGroups`): one or more containers
 * scheduled together on the same host, sharing a network and volumes, and
 * billed per second.
 *
 * It runs in two ways:
 *
 * - **A program** (`main`): Alchemy bundles a Node.js program, layers it
 *   onto a public Node.js image (no Docker needed), pushes the image to a
 *   Basic container registry it creates for the group, and runs it with a
 *   system-assigned managed identity and a public IP. Bindings grant that
 *   identity the roles they need.
 * - **Containers** (`containers`): the group runs the images you list.
 *
 * Deploys block until the group is provisioned. Changing an image (or the
 * program's code), command, environment, ports, or credentials re-deploys
 * the group in place (restarting its containers); changing the OS, SKU,
 * restart policy, container set, CPU/memory, volumes, or networking
 * replaces it.
 *
 * :::caution[A re-deploy restarts the containers]
 * Azure re-creates the containers on every spec change, so a program's
 * in-memory state is lost and its public IP can change. Set
 * `ipAddress.dnsNameLabel` (the default with `main`) and use `fqdn` or
 * `url`, not `ip`.
 * :::
 *
 * @see https://learn.microsoft.com/azure/container-instances/container-instances-overview
 *
 * ### Effect Programs
 * A program is a class. Props describe the group, and the Effect is the
 * program. `main: import.meta.url` makes the file both the bundle entry and
 * the program. Init binds resources; the returned `fetch` serves HTTP on
 * `port`, and `run` runs next to it.
 *
 * **Example:** Effect program with an HTTP handler
 * ```typescript
 * // src/api.ts
 * import * as Azure from "@alchemy.run/azure";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export default class Api extends Azure.ContainerInstance.ContainerGroup<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello from a container")),
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
 * **Example:** A background loop next to `fetch`
 * ```typescript
 * export default class Worker extends Azure.ContainerInstance.ContainerGroup<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     return {
 *       run: Effect.log("tick").pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
 *       fetch: Effect.succeed(HttpServerResponse.text("ok")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Async Programs
 * You don't have to use Effect. Call the group with `main` pointing at a
 * plain handler file and no implementation. Alchemy bundles that file as-is
 * (no Effect runtime in it) and serves its `fetch` on `port`. The `env` prop
 * takes literals, `Config` values, and resources, and `Azure.InferEnv`
 * types the handler's `env` argument.
 *
 * **Example:** Declaring an async program
 * ```typescript
 * // alchemy.run.ts
 * export const Hello = Azure.ContainerInstance.ContainerGroup("Hello", {
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
 * **Example:** Size, port, location, and base image
 * ```typescript
 * export default class Api extends Azure.ContainerInstance.ContainerGroup<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     location: "westeurope",
 *     cpu: 2,
 *     memoryInGB: 4,
 *     port: 8080,
 *     baseImage: "mcr.microsoft.com/azurelinux/base/nodejs:20",
 *     tags: { team: "web" },
 *   },
 *   program,
 * ) {}
 * ```
 *
 * **Example:** A sidecar next to the program
 * ```typescript
 * export default class Api extends Azure.ContainerInstance.ContainerGroup<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     containers: [
 *       { name: "cache", image: "mcr.microsoft.com/cbl-mariner/base/redis:6.2", cpu: 0.5, memoryInGB: 0.5 },
 *     ],
 *   },
 *   program, // reaches the sidecar on localhost:6379
 * ) {}
 * ```
 *
 * ### Networking
 * Pass `subnetIds` to run the group inside your virtual network with a
 * private IP. The subnet is delegated to
 * `Microsoft.ContainerInstance/containerGroups`. Changing either replaces
 * the group.
 *
 * **Example:** Private group in a delegated subnet
 * ```typescript
 * const subnet = yield* Azure.Network.Subnet("Containers", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.3.0/24",
 *   delegations: [{ serviceName: "Microsoft.ContainerInstance/containerGroups" }],
 * });
 * const api = yield* Azure.ContainerInstance.ContainerGroup("Api", {
 *   main: "./src/api.ts",
 *   subnetIds: [subnet.subnetId],
 *   ipAddress: { type: "Private", ports: [{ port: 8080, protocol: "TCP" }] },
 * });
 * // api.ip is a 10.0.3.x address
 * ```
 *
 * ### Logs and Cost
 * **Example:** Send container logs to Log Analytics
 * ```typescript
 * import type * as Redacted from "effect/Redacted";
 *
 * const logs = yield* Azure.LogAnalytics.Workspace("Logs");
 * const api = yield* Azure.ContainerInstance.ContainerGroup("Api", {
 *   main: "./src/api.ts",
 *   logAnalytics: {
 *     workspaceId: logs.customerId,
 *     workspaceKey: logs.primarySharedKey.as<Redacted.Redacted<string>>(),
 *   },
 * });
 * ```
 *
 * **Example:** Run on Spot capacity
 * ```typescript
 * // Spot groups are evictable and cannot have a public IP
 * const batch = yield* Azure.ContainerInstance.ContainerGroup("Batch", {
 *   priority: "Spot",
 *   restartPolicy: "Never",
 *   containers: [{ name: "batch", image: "mcr.microsoft.com/azuredocs/aci-wordcount" }],
 * });
 * ```
 *
 * ### Storage Bindings
 * Bindings grant the group's managed identity the smallest data role on
 * the bound resource only, and hand the program a typed client. The roles a
 * deploy no longer asks for are revoked. `BlobContainerReadWrite` grants
 * **Storage Blob Data Contributor** on the container.
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
 * `QueueSend` grants **Azure Service Bus Data Sender** and `QueueRead`
 * grants **Azure Service Bus Data Receiver**, each on the queue only.
 *
 * **Example:** Send a message
 * ```typescript
 * // init
 * const orders = yield* Azure.ServiceBus.QueueSend(queue);
 *
 * // runtime
 * yield* orders.send({ id: 1 }, { messageId: "order-1" });
 * // …provided with Effect.provide(Azure.ServiceBus.QueueSendHttp)
 * ```
 *
 * ### Controlling the Group from a Runtime
 * `StartContainerGroup`, `StopContainerGroup`, and `RestartContainerGroup`
 * let another runtime operate the group. Each grants a custom role with
 * only its one action, on this group only.
 *
 * **Example:** Restart the group from a Function
 * ```typescript
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const worker = yield* Worker;
 *     // init
 *     const restart = yield* Azure.ContainerInstance.RestartContainerGroup(worker);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         yield* restart();
 *         return HttpServerResponse.text("accepted");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ContainerInstance.RestartContainerGroupHttp)),
 * ) {}
 * ```
 *
 * ### Event Sources
 * Container Instances has no native triggers: a group serves HTTP and runs
 * its own loops. Poll a queue from `run` with a receive binding. For
 * triggers that scale from zero, use `Azure.ContainerApps.ContainerApp` or
 * `Azure.Functions.Function`.
 *
 * **Example:** Drain a Service Bus queue from `run`
 * ```typescript
 * const orders = yield* Azure.ServiceBus.QueueRead(queue);
 * return {
 *   run: Effect.gen(function* () {
 *     const message = yield* orders.receive({ timeoutSeconds: 30 });
 *     if (message !== undefined) {
 *       yield* Effect.log(message.text);
 *       yield* orders.complete(message);
 *     }
 *   }).pipe(Effect.orDie, Effect.forever),
 * };
 * // …provided with Effect.provide(Azure.ServiceBus.QueueReadHttp)
 * ```
 *
 * **Example:** Drain a Storage queue from `run`
 * ```typescript
 * const inbox = yield* Azure.Storage.QueueReceive(jobs);
 * return {
 *   run: Effect.gen(function* () {
 *     for (const message of yield* inbox.receive({ maxMessages: 32 })) {
 *       yield* Effect.log(message.text);
 *       yield* inbox.delete(message);
 *     }
 *   }).pipe(Effect.orDie, Effect.repeat(Schedule.spaced("10 seconds")), Effect.asVoid),
 * };
 * // …provided with Effect.provide(Azure.Storage.QueueReceiveHttp)
 * ```
 *
 * ### Running Containers
 * **Example:** Public web server
 * ```typescript
 * const web = yield* Azure.ContainerInstance.ContainerGroup("web", {
 *   containers: [
 *     {
 *       name: "web",
 *       image: "mcr.microsoft.com/azuredocs/aci-helloworld",
 *       cpu: 0.5,
 *       memoryInGB: 0.5,
 *       ports: [{ port: 80 }],
 *     },
 *   ],
 *   ipAddress: { type: "Public", ports: [{ port: 80, protocol: "TCP" }] },
 * });
 * // web.url serves HTTP on port 80
 * ```
 *
 * **Example:** Run-to-completion job
 * ```typescript
 * const job = yield* Azure.ContainerInstance.ContainerGroup("job", {
 *   restartPolicy: "Never",
 *   containers: [
 *     {
 *       name: "job",
 *       image: "mcr.microsoft.com/azuredocs/aci-wordcount",
 *       cpu: 1,
 *       memoryInGB: 1,
 *     },
 *   ],
 * });
 * ```
 *
 * ### Environment Variables and Secrets
 * **Example:** Plain and secure environment variables
 * ```typescript
 * const api = yield* Azure.ContainerInstance.ContainerGroup("api", {
 *   containers: [
 *     {
 *       name: "api",
 *       image: "myregistry.azurecr.io/api:1.0",
 *       environment: { MODE: "production" },
 *       secureEnvironment: { DB_PASSWORD: Redacted.make(password) },
 *     },
 *   ],
 *   imageRegistryCredentials: [
 *     {
 *       server: "myregistry.azurecr.io",
 *       username: "puller",
 *       password: Redacted.make(registryPassword),
 *     },
 *   ],
 * });
 * ```
 *
 * ### Identity
 * **Example:** System-assigned identity
 * ```typescript
 * const worker = yield* Azure.ContainerInstance.ContainerGroup("worker", {
 *   identity: { type: "SystemAssigned" },
 *   containers: [{ name: "worker", image }],
 * });
 * // worker.principalId can now be granted roles
 * ```
 *
 * @resource
 */
export const ContainerGroup: Platform<
  ContainerGroup,
  ContainerGroupServices,
  ContainerGroupShape,
  ContainerGroupRuntimeContext,
  {},
  ContainerGroupProps
> & {
  /**
   * Plain (no-impl) constructor: `containers`, or an async program in
   * `main`. Captures the `env` literal so `Azure.InferEnv` types the
   * handler's `env` argument.
   */
  <const Env extends Record<string, any>, PropsReq = never>(
    id: string,
    props:
      | InputProps<ContainerGroupProps<Env>>
      | Effect.Effect<InputProps<ContainerGroupProps<Env>>, never, PropsReq>,
  ): Effect.Effect<ContainerGroup<Env>, never, Providers | PropsReq>;
} = Platform(ContainerGroupTypeId, {
  createRuntimeContext: createContainerRuntimeContext(ContainerGroupTypeId),
  transformProps: (id, props) => transformContainerGroupProps(id, props),
});

export class ContainerGroupContainersMissing extends Data.TaggedError(
  "Azure.ContainerInstance.ContainerGroupContainersMissing",
)<{ message: string }> {}

export class ContainerGroupImageFailed extends Data.TaggedError(
  "Azure.ContainerInstance.ContainerGroupImageFailed",
)<{ image: string; message: string }> {}

export class ContainerGroupIdentityMissing extends Data.TaggedError(
  "Azure.ContainerInstance.ContainerGroupIdentityMissing",
)<{ containerGroupName: string; message: string }> {}

const DEFAULT_PORT = 3000;
const DEFAULT_BASE_IMAGE = "mcr.microsoft.com/azurelinux/base/nodejs:24";
/** Name of the program's container and of its image repository. */
const APP = "app";

type ObservedGroup = aci.GetContainerGroupResponse;

const getGroup = (subscriptionId: string, resourceGroupName: string, containerGroupName: string) =>
  orUndefinedIfNotFound(
    aci.GetContainerGroup({
      subscriptionId,
      resourceGroupName,
      containerGroupName,
    }),
  );

const groupUrl = (observed: Pick<ObservedGroup, "properties">) => {
  const address = observed.properties?.ipAddress;
  const host = address?.fqdn ?? address?.ip;
  const port = address?.ports?.[0]?.port;
  if (host === undefined || port === undefined || address?.type !== "Public") return undefined;
  return port === 80 ? `http://${host}` : `http://${host}:${port}`;
};

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Pick<ObservedGroup, "id" | "location" | "properties" | "identity" | "tags">,
  extras: { image?: string; codeHash?: string; specHash?: string } = {},
): ContainerGroupAttributes => ({
  containerGroupName: name,
  containerGroupId: observed.id ?? "",
  resourceGroup,
  location: observed.location ?? "",
  ip: observed.properties?.ipAddress?.ip,
  fqdn: observed.properties?.ipAddress?.fqdn,
  url: groupUrl(observed),
  state: observed.properties?.instanceView?.state,
  principalId: observed.identity?.principalId,
  image: extras.image,
  codeHash: extras.codeHash,
  specHash: extras.specHash,
  tags: userTags(observed.tags),
});

/** The full PUT `properties` body (secret values revealed). */
const toProperties = (
  props: ContainerGroupProps,
  containers: ReadonlyArray<ContainerInstanceContainer>,
  extra: {
    ipAddress?: ContainerInstanceIpAddress;
    registryCredentials?: ContainerInstanceRegistryCredential[];
  } = {},
): aci.ContainerGroupPropertiesPropertiesInput => ({
  containers: toContainers(containers),
  initContainers: props.initContainers,
  osType: props.osType ?? "Linux",
  sku: props.sku,
  restartPolicy: props.restartPolicy ?? "Always",
  ipAddress: extra.ipAddress ?? props.ipAddress,
  imageRegistryCredentials: toRegistryCredentials([
    ...(props.imageRegistryCredentials ?? []),
    ...(extra.registryCredentials ?? []),
  ]),
  volumes: props.volumes,
  diagnostics: toDiagnostics(props.logAnalytics),
  subnetIds: props.subnetIds?.map((id) => ({ id })),
  dnsConfig: props.dnsConfig,
  priority: props.priority,
});

/** Previous-props fingerprint; secrets included so a rotated one re-deploys. */
const propsFingerprint = (props: ContainerGroupProps) =>
  fingerprint({ ...toProperties(props, props.containers ?? []), identity: props.identity });

/** The identity a group gets: a program always has a system-assigned one. */
const desiredIdentity = (props: ContainerGroupProps): ContainerInstanceIdentity | undefined => {
  if (props.main === undefined) return props.identity;
  const users = props.identity?.userAssignedIdentities ?? [];
  return users.length > 0 && props.identity?.type !== "SystemAssigned"
    ? { type: "SystemAssigned, UserAssigned", userAssignedIdentities: users }
    : { type: "SystemAssigned" };
};

/** Name, CPU, and memory of every container; a change replaces the group. */
const containerShape = (props: ContainerGroupProps) =>
  [
    ...(props.main !== undefined
      ? [{ name: APP, cpu: props.cpu ?? 1, memoryInGB: props.memoryInGB ?? 1.5 }]
      : []),
    ...(props.containers ?? []).map((c) => ({
      name: c.name,
      cpu: c.cpu ?? 1,
      memoryInGB: c.memoryInGB ?? 1.5,
    })),
  ]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `${c.name}:${c.cpu}:${c.memoryInGB}`)
    .join("|");

const sorted = (values: ReadonlyArray<string> | undefined) =>
  (values ?? [])
    .map((v) => v.toLowerCase())
    .sort()
    .join("|");

/** Generated entry of an Effect program: raise the runtime flag, run the program. */
const effectEntry = (handler: string) => (importPath: string) =>
  `
import { bootstrap } from "@alchemy.run/azure/Bootstrap/ContainerGroup";

globalThis.__ALCHEMY_RUNTIME__ = true;
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});

await bootstrap(entrypoint);
`;

/** Generated entry of an async program: no Effect, just the handler file. */
const asyncEntry = (handler: string, envKeys: readonly string[]) => (importPath: string) =>
  `
import { serve } from "@alchemy.run/azure/Bootstrap/ContainerGroupAsync";
import { ${handler} as handler } from ${JSON.stringify(importPath)};

serve(handler, ${JSON.stringify(envKeys)});
`;

const makeBundler = Effect.gen(function* () {
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
  return Effect.fn(function* (props: ContainerGroupProps & { main: string }) {
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
    const files = output.files.map((file) => ({
      path: file.path,
      content:
        typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content,
    }));
    const codeHash = (yield* sha256Object({
      bundle: output.hash,
      envKeys: props.isExternal ? envKeys : [],
      baseImage: props.baseImage ?? DEFAULT_BASE_IMAGE,
      port: props.port ?? DEFAULT_PORT,
    })).slice(0, 16);
    return { files, codeHash };
  });
});

/** `mcr.microsoft.com/a/b:tag` → `{ registryUri, sourceImage }` (Docker Hub when no registry). */
const splitImage = (image: string) => {
  const slash = image.indexOf("/");
  const first = slash === -1 ? "" : image.slice(0, slash);
  if (first.includes(".") || first.includes(":") || first === "localhost") {
    return { registryUri: first, sourceImage: image.slice(slash + 1) };
  }
  return {
    registryUri: "docker.io",
    sourceImage: slash === -1 ? `library/${image}` : image,
  };
};

const digestOf = (bytes: Uint8Array) => Effect.map(sha256(bytes), (hex) => `sha256:${hex}`);

const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const DOCKER_LAYER = "application/vnd.docker.image.rootfs.diff.tar.gzip";
const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip";

/** The image config fields this module rewrites; the rest is passed through. */
interface ImageConfig {
  config?: Record<string, unknown> & { ExposedPorts?: Record<string, object> };
  rootfs?: { type?: string; diff_ids?: string[] };
  history?: Record<string, unknown>[];
  [key: string]: unknown;
}

/**
 * Push `<loginServer>/app:<codeHash>`: the base image (imported into the
 * registry once, server side) plus one layer holding the bundle under
 * `/app`, with `node /app/index.mjs` as the entrypoint. No Docker daemon.
 */
const pushProgramImage = Effect.fn(function* (options: {
  subscriptionId: string;
  hosting: ContainerGroupHosting;
  baseImage: string;
  files: ReadonlyArray<{ path: string; content: Uint8Array }>;
  codeHash: string;
  port: number;
}) {
  const { hosting, codeHash } = options;
  const endpoint = `https://${hosting.loginServer}`;
  const image = `${hosting.loginServer}/${APP}:${codeHash}`;
  const getManifest = (reference: string) =>
    acr
      .GetContainerRegistryManifest({ endpoint, name: APP, reference })
      .pipe(
        Effect.catchTag(
          ["ContainerRegistryManifestNotFound", "ContainerRegistryRepositoryNotFound"],
          () => Effect.succeed(undefined),
        ),
      );

  if ((yield* getManifest(codeHash)) !== undefined) return image;

  // Import the base image into the same repository, so the program's
  // manifest can reference its layers.
  const baseTag = `base-${options.baseImage.replace(/[^A-Za-z0-9_.-]+/g, "-")}`.slice(0, 128);
  let base = yield* getManifest(baseTag);
  if (base === undefined) {
    yield* containerregistry.ImportRegistryImage({
      subscriptionId: options.subscriptionId,
      resourceGroupName: hosting.resourceGroup,
      registryName: hosting.registryName,
      source: splitImage(options.baseImage),
      targetTags: [`${APP}:${baseTag}`],
      mode: "Force",
    });
    base = yield* getManifest(baseTag).pipe(
      Effect.flatMap((m) =>
        m === undefined
          ? Effect.fail(
              new ContainerGroupImageFailed({
                image: options.baseImage,
                message: `importing ${options.baseImage} into ${hosting.loginServer} did not finish`,
              }),
            )
          : Effect.succeed(m),
      ),
      // An import of a public image takes 10-60 seconds.
      Effect.retry({
        while: (e) => e._tag === "Azure.ContainerInstance.ContainerGroupImageFailed",
        schedule: Schedule.spaced("5 seconds"),
        times: 36,
      }),
    );
  }
  // A multi-platform base: take its linux/amd64 image (ACI runs amd64).
  if (base.manifests !== undefined) {
    const amd64 = base.manifests.find(
      (m) => m.platform?.os === "linux" && m.platform?.architecture === "amd64",
    );
    const resolved = amd64?.digest === undefined ? undefined : yield* getManifest(amd64.digest);
    if (resolved === undefined) {
      return yield* new ContainerGroupImageFailed({
        image: options.baseImage,
        message: `${options.baseImage} has no linux/amd64 image`,
      });
    }
    base = resolved;
  }
  const configDigest = base.config?.digest;
  if (configDigest === undefined || base.layers === undefined) {
    return yield* new ContainerGroupImageFailed({
      image: options.baseImage,
      message: `${options.baseImage} is not a single-platform image manifest`,
    });
  }

  // The bundle as a gzipped tar of `app/`.
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layer = yield* Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-aci-" });
      for (const file of options.files) {
        const target = path.join(dir, APP, file.path);
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFile(target, file.content);
      }
      return new Uint8Array(yield* tarGzipDirectory(dir));
    }),
  );
  const tar = yield* Effect.sync(() => new Uint8Array(zlib.gunzipSync(layer)));

  const baseConfig = yield* acr.GetContainerRegistryBlobBlob({
    endpoint,
    name: APP,
    digest: configDigest,
  });
  const config = JSON.parse(new TextDecoder().decode(baseConfig.body)) as ImageConfig;
  const diffId = yield* digestOf(tar);
  const runConfig = { ...config.config };
  delete runConfig.Cmd;
  const nextConfig: ImageConfig = {
    ...config,
    config: {
      ...runConfig,
      WorkingDir: `/${APP}`,
      Entrypoint: ["node", `/${APP}/index.mjs`],
      ExposedPorts: { ...runConfig.ExposedPorts, [`${options.port}/tcp`]: {} },
    },
    rootfs: { type: "layers", diff_ids: [...(config.rootfs?.diff_ids ?? []), diffId] },
    history: [...(config.history ?? []), { created_by: "alchemy: COPY bundle /app" }],
  };
  const configBytes = new TextEncoder().encode(JSON.stringify(nextConfig));

  const upload = Effect.fn(function* (bytes: Uint8Array) {
    const digest = yield* digestOf(bytes);
    const started = yield* acr.ContainerRegistryBlobStartUpload({ endpoint, name: APP });
    yield* acr.UploadContainerRegistryBlobComplete({
      endpoint,
      nextBlobUuidLink: started.location ?? `/v2/${APP}/blobs/uploads/`,
      digest,
      body: bytes,
    });
    return { digest, size: bytes.byteLength };
  });
  const layerBlob = yield* upload(layer);
  const configBlob = yield* upload(configBytes);

  const mediaType = base.mediaType ?? DOCKER_MANIFEST;
  const manifest = {
    schemaVersion: 2,
    mediaType,
    config: { mediaType: base.config?.mediaType, ...configBlob },
    layers: [
      ...base.layers.map((l) => ({ mediaType: l.mediaType, size: l.size, digest: l.digest })),
      { mediaType: mediaType === DOCKER_MANIFEST ? DOCKER_LAYER : OCI_LAYER, ...layerBlob },
    ],
  };
  yield* acr.CreateContainerRegistryManifest({
    endpoint,
    name: APP,
    reference: codeHash,
    payload: new TextEncoder().encode(JSON.stringify(manifest)),
    contentType: mediaType,
  });
  return image;
});

/** An env value as a string; a secret (or a packed secret) goes to secure env. */
const splitEnv = (values: Record<string, unknown>) => {
  const plain: Record<string, string> = {};
  const secure: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const packed = typeof value === "string" ? value : packEnvValue(value);
    const secret =
      Redacted.isRedacted(value) ||
      (typeof value === "string" && Redacted.isRedacted(unpackEnvValue(value)));
    if (secret) secure[key] = packed;
    else plain[key] = packed;
  }
  return { plain, secure };
};

const collectBindings = (bindings: ResourceBinding<ContainerGroupBinding>[]) => {
  const env: Record<string, unknown> = {};
  const grants = new Map<string, ContainerGroupRoleAssignment>();
  const active = bindings.filter(
    (b: ResourceBinding<ContainerGroupBinding> & { action?: string }) => b.action !== "delete",
  );
  for (const binding of active) {
    Object.assign(env, binding.data.env ?? {});
    for (const grant of binding.data.roleAssignments ?? []) {
      grants.set(`${grant.scope.toLowerCase()}|${grant.roleDefinitionId.toLowerCase()}`, grant);
    }
  }
  return { env, grants: [...grants.values()] };
};

export const ContainerGroupProvider = () =>
  Provider.effect(
    ContainerGroup,
    Effect.gen(function* () {
      const bundle = yield* makeBundler;

      return ContainerGroup.Provider.of({
        stables: ["containerGroupName", "containerGroupId", "resourceGroup", "location"],

        list: Effect.fn(function* () {
          const { subscriptionId } = yield* AzureEnvironment.current;
          const page = yield* collectAll(aci.ListContainerGroups, { subscriptionId });
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
          const props = news as ContainerGroupProps;
          const ip = props.ipAddress;
          const oldIp = olds.ipAddress;
          if (
            (props.resourceGroup !== undefined &&
              lower(props.resourceGroup) !== lower(output.resourceGroup)) ||
            (props.name !== undefined && props.name !== output.containerGroupName) ||
            (props.location !== undefined && !sameLocation(props.location, output.location)) ||
            sorted(props.zones) !== sorted(olds.zones) ||
            (props.osType ?? "Linux") !== (olds.osType ?? "Linux") ||
            (props.sku ?? "Standard") !== (olds.sku ?? "Standard") ||
            (props.restartPolicy ?? "Always") !== (olds.restartPolicy ?? "Always") ||
            (props.priority ?? "Regular") !== (olds.priority ?? "Regular") ||
            ip?.type !== oldIp?.type ||
            lower(ip?.dnsNameLabel) !== lower(oldIp?.dnsNameLabel) ||
            ip?.autoGeneratedDomainNameLabelScope !== oldIp?.autoGeneratedDomainNameLabelScope ||
            sorted(props.subnetIds) !== sorted(olds.subnetIds) ||
            fingerprint(props.dnsConfig ?? null) !== fingerprint(olds.dnsConfig ?? null) ||
            fingerprint(props.volumes ?? []) !== fingerprint(olds.volumes ?? []) ||
            fingerprint(props.initContainers ?? []) !== fingerprint(olds.initContainers ?? []) ||
            containerShape(props) !== containerShape(olds)
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
          const name =
            output?.containerGroupName ?? olds?.name ?? (yield* createContainerInstanceName(id));
          const observed = yield* getGroup(subscriptionId, resourceGroup, name);
          if (observed === undefined) return undefined;
          const attrs = toAttrs(resourceGroup, name, observed, {
            image: output?.image,
            codeHash: output?.codeHash,
            specHash: output?.specHash,
          });
          return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, olds, output, bindings }) {
          const env = yield* AzureEnvironment.current;
          const { subscriptionId } = env;
          yield* ensureRegistered(subscriptionId, "Microsoft.ContainerInstance");
          const resourceGroup = news.resourceGroup;
          if (resourceGroup === undefined) {
            return yield* new ContainerGroupContainersMissing({
              message: `Azure.ContainerInstance.ContainerGroup "${id}" has no resource group`,
            });
          }
          const name =
            news.name ?? output?.containerGroupName ?? (yield* createContainerInstanceName(id));
          const location = news.location ?? output?.location ?? env.location;
          const tags = yield* desiredTags(id, news.tags);
          const collected = collectBindings(bindings as ResourceBinding<ContainerGroupBinding>[]);

          // The program's container: its image is pushed to the group's
          // registry, its env is the stack identity, binding env, then `env`.
          let containers = news.containers ?? [];
          let ipAddress: ContainerInstanceIpAddress | undefined;
          let registryCredentials: ContainerInstanceRegistryCredential[] = [];
          let image: string | undefined;
          let codeHash: string | undefined;
          if (news.main !== undefined) {
            const hosting = news.hosting;
            if (hosting === undefined) {
              return yield* new ContainerGroupContainersMissing({
                message: `Azure.ContainerInstance.ContainerGroup "${id}" has no registry to push its program to`,
              });
            }
            const port = news.port ?? DEFAULT_PORT;
            const built = yield* bundle({ ...news, main: news.main });
            codeHash = built.codeHash;
            image = yield* pushProgramImage({
              subscriptionId,
              hosting,
              baseImage: news.baseImage ?? DEFAULT_BASE_IMAGE,
              files: built.files,
              codeHash,
              port,
            });
            const credentials = yield* containerregistry.ListRegistryCredentials({
              subscriptionId,
              resourceGroupName: hosting.resourceGroup,
              registryName: hosting.registryName,
            });
            const password = credentials.passwords?.[0]?.value;
            registryCredentials = [
              {
                server: hosting.loginServer,
                username: credentials.username ?? hosting.registryName,
                password: password === undefined ? undefined : Redacted.make(password),
              },
            ];
            const stack = yield* Stack;
            const { plain, secure } = splitEnv({
              ALCHEMY_STACK_NAME: stack.name,
              ALCHEMY_STAGE: stack.stage,
              ALCHEMY_PHASE: "runtime",
              PORT: String(port),
              ...collected.env,
              ...news.env,
            });
            containers = [
              {
                name: APP,
                image,
                cpu: news.cpu ?? 1,
                memoryInGB: news.memoryInGB ?? 1.5,
                ports: [{ port, protocol: "TCP" }],
                environment: plain,
                secureEnvironment: secure,
              },
              ...containers,
            ];
            ipAddress = news.ipAddress ?? {
              type: "Public",
              ports: [{ port, protocol: "TCP" }],
              dnsNameLabel: name,
            };
          } else if (containers.length === 0) {
            return yield* new ContainerGroupContainersMissing({
              message: `Azure.ContainerInstance.ContainerGroup "${id}" needs \`main\` or \`containers\``,
            });
          }

          const identity = desiredIdentity(news);
          const properties = toProperties(news, containers, { ipAddress, registryCredentials });
          const specHash = (yield* sha256Object({
            properties: fingerprint(properties),
            identity: identity ?? null,
            zones: news.zones ?? [],
          })).slice(0, 16);
          const where = {
            subscriptionId,
            resourceGroupName: resourceGroup,
            containerGroupName: name,
          };
          const get = getGroup(subscriptionId, resourceGroup, name);
          const ready = waitForProvisioned(
            `container group ${name}`,
            get,
            (group) => group.properties?.provisioningState,
            // Re-deploying a running group restarts it; observed 2-10 minutes.
            { interval: "10 seconds", times: 60 },
          );
          const put = aci.ContainerGroupsCreateOrUpdate({
            ...where,
            location,
            zones: news.zones,
            tags,
            identity: toIdentity(identity),
            properties,
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
            // Sync the spec: a re-PUT re-deploys (restarts) the containers, so
            // only send it when the observed spec or a secret drifted.
            const secretsInSync =
              output?.specHash !== undefined
                ? output.specHash === specHash
                : olds === undefined || propsFingerprint(news) === propsFingerprint(olds);
            const specInSync =
              matchesDesired(comparable(properties), comparable(observed.properties)) &&
              identityMatches(identity, observed.identity) &&
              secretsInSync;
            if (!specInSync) {
              yield* put;
              observed = yield* ready;
            }
          }

          // Sync tags with a PATCH (no restart). A PUT of an existing group
          // does not always apply tag changes.
          if (tagsDiffer(observed.tags, tags)) {
            yield* aci.UpdateContainerGroup({ ...where, tags });
            observed = yield* ready;
          }

          // Grant the binding roles to the identity; revoke the ones no
          // binding asks for any more.
          const principalId = observed.identity?.principalId;
          if (principalId !== undefined && observed.id !== undefined) {
            yield* syncBindingAssignments({
              id,
              subscriptionId,
              appId: observed.id,
              principalId,
              grants: collected.grants,
            });
          } else if (collected.grants.length > 0) {
            return yield* new ContainerGroupIdentityMissing({
              containerGroupName: name,
              message: `container group ${name} needs a system-assigned identity for its role assignments`,
            });
          }

          return toAttrs(resourceGroup, name, observed, { image, codeHash, specHash });
        }),

        delete: Effect.fn(function* ({ id, output }) {
          const { subscriptionId } = yield* AzureEnvironment.current;
          // Role assignments outlive their principal; revoke them first.
          const observed = yield* getGroup(
            subscriptionId,
            output.resourceGroup,
            output.containerGroupName,
          );
          const principalId = observed?.identity?.principalId ?? output.principalId;
          if (principalId !== undefined) {
            yield* syncBindingAssignments({
              id,
              subscriptionId,
              appId: observed?.id ?? output.containerGroupId,
              principalId,
              grants: [],
            });
          }
          yield* ignoreNotFound(
            aci.DeleteContainerGroup({
              subscriptionId,
              resourceGroupName: output.resourceGroup,
              containerGroupName: output.containerGroupName,
            }),
          );
          yield* waitUntilGone(
            `container group ${output.containerGroupName}`,
            getGroup(subscriptionId, output.resourceGroup, output.containerGroupName),
            { interval: "5 seconds", times: 60 },
          );
        }),

        nuke: {
          dependsOn: ["Azure.Resources.ResourceGroup", "Azure.ContainerRegistry.Registry"],
        },
      });
    }),
  );
