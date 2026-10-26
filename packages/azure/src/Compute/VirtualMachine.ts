import type { Credentials } from "@distilled.cloud/azure";
import * as compute from "@distilled.cloud/azure/compute";
import * as network from "@distilled.cloud/azure/network";
import * as storage from "@distilled.cloud/azure/storage";
import * as blob from "@distilled.cloud/azure/storage-blob";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Bundle from "alchemy/Bundle/Bundle";
import { findCwdForBundle, resolveMainPath } from "alchemy/Bundle/TempRoot";
import { isResolved } from "alchemy/Diff";
import type { InputProps } from "alchemy/Input";
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
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
} from "../Arm.ts";
import { managedIdentityHostBundle } from "../AzureBindings.ts";
import { syncBindingAssignments } from "../ContainerApps/ContainerApp.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { stackResourceGroup } from "../StackResourceGroup.ts";
import { BlobContainer } from "../Storage/BlobContainer.ts";
import { StorageAccount } from "../Storage/StorageAccount.ts";
import {
  canonical,
  createComputeName,
  ref,
  sameId,
  sameSet,
  waitComputeGone,
  waitComputeProvisioned,
  whileComputeBusy,
} from "./common.ts";

export type { InferEnv } from "../InferEnv.ts";

export const VirtualMachineTypeId = "Azure.Compute.VirtualMachine" as const;
export type VirtualMachineTypeId = typeof VirtualMachineTypeId;

/** A platform (marketplace) image, or a custom image / gallery image by ID. */
export type VirtualMachineImage =
  | {
      /** Image publisher, e.g. `Canonical`. */
      publisher: string;
      /** Image offer, e.g. `ubuntu-24_04-lts`. */
      offer: string;
      /** Image SKU, e.g. `server`. */
      sku: string;
      /**
       * Image version.
       * @default "latest"
       */
      version?: string;
    }
  | {
      /** ARM ID of a managed image or a Compute Gallery image (version). */
      id: string;
    };

export interface VirtualMachineIdentity {
  /** Enable the system-assigned managed identity. */
  systemAssigned?: boolean;
  /** ARM IDs of user-assigned managed identities to attach. */
  userAssignedIdentityIds?: string[];
}

/** A role the VM's managed identity holds on one scope. */
export interface VirtualMachineRoleAssignment {
  /** Built-in role GUID or full role-definition ARM ID. */
  roleDefinitionId: string;
  /** ARM ID the role is granted on: the bound resource, never wider. */
  scope: string;
}

/**
 * Binding contract accepted by `Azure.Compute.VirtualMachine` (the Azure
 * `HostBinding` shape):
 *
 * - `roleAssignments` are granted to the VM's system-assigned identity; the
 *   ones a deploy no longer asks for are revoked (only ones it made).
 * - `env` becomes the program's environment.
 */
export interface VirtualMachineBinding {
  /** Roles granted to the VM's system-assigned identity, each on one scope. */
  roleAssignments?: VirtualMachineRoleAssignment[];
  /**
   * Program env the binding contributes. The VM's own `env` wins on a key
   * clash.
   */
  env?: Record<string, unknown>;
}

/**
 * Where Alchemy stages a program's releases. Set automatically.
 * @internal
 */
export interface VirtualMachineHosting {
  /** Resource group of the staging storage account. */
  resourceGroup: string;
  /** Name of the storage account that stages releases. */
  storageAccountName: string;
  /** Primary blob endpoint of the staging storage account. */
  blobEndpoint: string;
  /** Name of the blob container that holds the release blobs. */
  containerName: string;
}

export interface VirtualMachineProps<
  Env extends Record<string, any> = Record<string, any>,
> extends PlatformProps {
  /**
   * Resource group the VM is created in. Changing it replaces the VM.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup?: string;
  /**
   * Name of the VM: 1-64 letters, digits, `.`, `_`, and `-`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the VM.
   */
  name?: string;
  /**
   * Azure location of the VM; the NICs must be in the same location.
   * Changing it replaces the VM.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Availability zone(s) to place the VM in. Changing them replaces the VM.
   */
  zones?: string[];
  /**
   * VM size, e.g. `Standard_B1s` or `Standard_D2s_v5`. Resizing happens in
   * place; Azure restarts the VM, and fails with `OperationNotAllowed` if
   * the new size is not available on the current hardware cluster. A size
   * without capacity in the region fails with `SkuNotAvailable`.
   */
  vmSize: string;
  /**
   * OS image. Changing it replaces the VM. A VM that runs a program
   * (`main`) needs a Linux image with `curl`, `tar`, `xz`, and systemd.
   * @default Ubuntu 24.04 LTS (`Canonical` / `ubuntu-24_04-lts` / `server` / `latest`)
   */
  image?: VirtualMachineImage;
  /**
   * Storage type of the managed OS disk. Changing it replaces the VM.
   * @default "Standard_LRS"
   */
  osDiskStorageAccountType?:
    | "Standard_LRS"
    | "StandardSSD_LRS"
    | "Premium_LRS"
    | "StandardSSD_ZRS"
    | "Premium_ZRS";
  /**
   * Size of the OS disk in GiB. Changing it replaces the VM.
   * @default the image's disk size
   */
  osDiskSizeGB?: number;
  /**
   * ARM IDs of the network interfaces; the first is primary. Changing them
   * replaces the VM. NICs are detached, not deleted, with the VM. A VM is
   * always replaced delete-first, since its NICs cannot be shared.
   */
  networkInterfaceIds: string[];
  /**
   * Administrator user name. Changing it replaces the VM.
   */
  adminUsername: string;
  /**
   * Administrator password. Required for Windows; for Linux, set it to
   * enable password login. Changing it replaces the VM.
   */
  adminPassword?: Redacted.Redacted<string>;
  /**
   * OpenSSH public keys authorised for `adminUsername` (Linux). When set
   * and no `adminPassword` is given, password login is disabled. Changing
   * them replaces the VM.
   */
  sshPublicKeys?: string[];
  /**
   * Host name of the VM (Windows: at most 15 characters). Changing it
   * replaces the VM.
   * @default the VM name
   */
  computerName?: string;
  /**
   * Base64-encoded custom data (cloud-init) passed at provisioning.
   * Changing it replaces the VM.
   */
  customData?: string;
  /**
   * Base64-encoded user data available to the VM through the instance
   * metadata service. Updated in place.
   */
  userData?: string;
  /**
   * Enable boot diagnostics with managed storage. Updated in place.
   * @default false
   */
  bootDiagnostics?: boolean;
  /**
   * Managed identities of the VM. Updated in place. A VM that runs a
   * program always has its system-assigned identity enabled.
   */
  identity?: VirtualMachineIdentity;
  /**
   * Security type. Changing it replaces the VM.
   * @default Azure's default for the image (`TrustedLaunch` for Gen2 images)
   */
  securityType?: "TrustedLaunch" | "ConfidentialVM" | "Standard";
  /**
   * ARM ID of an availability set to place the VM in. Changing it replaces
   * the VM.
   */
  availabilitySetId?: string;
  /**
   * ARM ID of a proximity placement group. Changing it replaces the VM.
   */
  proximityPlacementGroupId?: string;
  /**
   * ARM ID of a dedicated host to place the VM on. Changing it replaces
   * the VM.
   */
  hostId?: string;
  /**
   * ARM ID of a dedicated host group with automatic placement. Changing it
   * replaces the VM.
   */
  hostGroupId?: string;
  /**
   * ARM ID of a capacity reservation group to draw capacity from. Changing
   * it replaces the VM.
   */
  capacityReservationGroupId?: string;
  /**
   * Priority: `Spot` VMs are cheap but can be evicted. Changing it replaces
   * the VM.
   * @default "Regular"
   */
  priority?: "Regular" | "Spot" | "Low";
  /**
   * What happens to an evicted Spot VM. Changing it replaces the VM.
   * @default "Deallocate" for Spot VMs
   */
  evictionPolicy?: "Deallocate" | "Delete";
  /**
   * Maximum hourly price for a Spot VM in USD; `-1` means up to the
   * on-demand price. Updated in place.
   */
  maxPrice?: number;
  /**
   * Azure Hybrid Benefit license type (e.g. `Windows_Server`,
   * `RHEL_BYOS`). Updated in place.
   */
  licenseType?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
  /**
   * Program the VM runs. For an Effect VM this is `import.meta.url` (the
   * file is both the bundle entry and the program). For an async VM it is
   * a handler file that default-exports `{ fetch(request, env) }`. Alchemy
   * bundles it for Node.js 22 into ESM and runs it as a systemd unit.
   * Without `main`, the VM is plain infrastructure.
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
   * Port the program's HTTP server listens on (set as `PORT`). Open it in
   * the NIC's network security group to reach the program.
   * @default 3000
   */
  port?: number;
  /**
   * Environment variables of the program. Accepts literals, `Config`
   * values, Outputs, and resources (a resource arrives as its attributes,
   * JSON-encoded). Merged after the `env` that bindings contribute. A
   * change restarts the program in place.
   *
   * On an async VM, {@link InferEnv} types the handler's `env` argument
   * from this object.
   */
  env?: Env;
  /** @internal Set automatically by Alchemy. */
  hosting?: VirtualMachineHosting;
}

export interface VirtualMachineAttributes {
  /** Name of the VM. */
  virtualMachineName: string;
  /** ARM resource ID of the VM. */
  virtualMachineId: string;
  /** Immutable GUID Azure assigned to the VM (`vmId`). */
  vmId: string | undefined;
  /** Resource group that holds the VM. */
  resourceGroup: string;
  /** Location of the VM. */
  location: string;
  /** Zones the VM is placed in. */
  zones: string[];
  /** VM size. */
  vmSize: string | undefined;
  /** Host name of the VM. */
  computerName: string | undefined;
  /** Name of the managed OS disk. */
  osDiskName: string | undefined;
  /** ARM ID of the managed OS disk. */
  osDiskId: string | undefined;
  /** ARM IDs of the attached network interfaces. */
  networkInterfaceIds: string[];
  /** Principal ID of the system-assigned identity, if enabled. */
  principalId: string | undefined;
  /** Tenant ID of the system-assigned identity, if enabled. */
  tenantId: string | undefined;
  /** Creation time (ISO 8601). */
  timeCreated: string | undefined;
  /** User tags (Alchemy ownership tags stripped). */
  tags: Record<string, string>;
  /** Private IP address of the primary NIC. */
  privateIpAddress?: string;
  /** Public IP address of the primary NIC, if it has one. */
  publicIpAddress?: string;
  /** Port the program listens on (VMs that run a program). */
  port?: number;
  /** `http://<publicIpAddress>:<port>` for a program on a VM with a public IP. */
  url?: string;
  /** systemd unit that runs the program. */
  unitName?: string;
  /** Hash of the deployed bundle. */
  codeHash?: string;
  /** Hash of the deployed release (bundle and env). */
  releaseHash?: string;
}

export interface VirtualMachine<
  Env extends Record<string, any> = Record<string, any>,
> extends Resource<
  VirtualMachineTypeId,
  VirtualMachineProps<Env>,
  VirtualMachineAttributes,
  VirtualMachineBinding,
  Providers
> {}

export type VirtualMachineServices = Credentials | ServerHost;
export type VirtualMachineShape = Main<VirtualMachineServices>;
export type VirtualMachineRuntimeContext = HostRuntimeContext;

const transformVirtualMachineProps = (id: string, props: VirtualMachineProps) =>
  Effect.gen(function* () {
    // Composition is a deploy concern; inside the bundle props are final.
    if (globalThis.__ALCHEMY_RUNTIME__) return props;
    const resourceGroup = props.resourceGroup ?? (yield* stackResourceGroup).name;
    if (props.main === undefined || props.hosting !== undefined) {
      return { ...props, resourceGroup };
    }
    const hosting = yield* Effect.gen(function* () {
      const account = yield* StorageAccount("ReleaseStorage", {
        resourceGroup,
        location: props.location,
      });
      const releases = yield* BlobContainer("ReleaseContainer", {
        resourceGroup,
        storageAccount: account.storageAccountName,
      });
      return {
        resourceGroup,
        storageAccountName: account.storageAccountName,
        blobEndpoint: account.primaryEndpoints.blob,
        containerName: releases.containerName,
      };
    }).pipe(Namespace.push(id));
    return { ...props, resourceGroup, hosting };
  });

/**
 * An Azure virtual machine with a managed OS disk, optionally running a
 * Node.js 22 program that Alchemy bundles and deploys.
 *
 * The OS disk is deleted with the VM; network interfaces are only detached
 * (create them with `Azure.Network.NetworkInterface`). The VM is ready when
 * the deploy returns (`provisioningState: Succeeded`).
 *
 * With `main`, the VM runs a program as a systemd unit (`Restart=always`,
 * so it survives crashes and reboots) under its system-assigned managed
 * identity. Alchemy bundles `main`, stages the release in a storage account
 * it creates next to the VM, and installs it with a managed run command
 * (no SSH): the command installs Node.js 22 if missing, unpacks the
 * release, and restarts the unit. A deploy re-runs it only when the bundle
 * or the env changed. The program's HTTP server listens on `port`; give the
 * NIC a public IP and allow the port in its network security group to
 * reach it.
 *
 * :::caution[Changing the image, admin user, SSH keys, NICs, or placement replaces the VM]
 * The VM is deleted first (its NICs cannot be shared), then created again.
 * :::
 *
 * :::caution[A program needs outbound internet and a systemd Linux image]
 * The install command downloads Node.js 22 from `nodejs.org` and the
 * release from the staging storage account with `curl`, so the subnet
 * needs outbound access (a NAT gateway or public IP once default outbound
 * access is off). The image needs `curl`, `tar`, `xz`, and systemd.
 * :::
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/overview
 *
 * ### Creating a Linux VM
 * **Example:** Ubuntu VM with SSH key authentication
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("vms", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 * });
 * const nic = yield* Azure.Network.NetworkInterface("web", {
 *   ipConfigurations: [{ subnetId: subnet.subnetId }],
 * });
 * const vm = yield* Azure.Compute.VirtualMachine("web", {
 *   vmSize: "Standard_B1s",
 *   networkInterfaceIds: [nic.networkInterfaceId],
 *   adminUsername: "azureuser",
 *   sshPublicKeys: ["ssh-ed25519 AAAAC3Nza... me@example.com"],
 * });
 * ```
 *
 * ### Choosing an Image
 * **Example:** Debian 12 on Premium SSD
 * ```typescript
 * const vm = yield* Azure.Compute.VirtualMachine("db", {
 *   vmSize: "Standard_D2s_v5",
 *   image: { publisher: "Debian", offer: "debian-12", sku: "12-gen2" },
 *   osDiskStorageAccountType: "Premium_LRS",
 *   networkInterfaceIds: [nic.networkInterfaceId],
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 * });
 * ```
 *
 * ### Identity and Diagnostics
 * **Example:** System-assigned identity with boot diagnostics
 * ```typescript
 * const vm = yield* Azure.Compute.VirtualMachine("worker", {
 *   vmSize: "Standard_B1s",
 *   networkInterfaceIds: [nic.networkInterfaceId],
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 *   identity: { systemAssigned: true },
 *   bootDiagnostics: true,
 * });
 * // grant vm.principalId access with Azure.Authorization.RoleAssignment
 * ```
 *
 * ### Spot VMs
 * **Example:** Spot VM that is deallocated on eviction
 * ```typescript
 * const vm = yield* Azure.Compute.VirtualMachine("batch", {
 *   vmSize: "Standard_D2s_v5",
 *   networkInterfaceIds: [nic.networkInterfaceId],
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 *   priority: "Spot",
 *   evictionPolicy: "Deallocate",
 *   maxPrice: -1,
 * });
 * ```
 *
 * ### Networking for a Program
 * A program is reached over the NIC's public IP. Standard public IPs
 * block inbound traffic until a network security group allows it.
 *
 * **Example:** Public IP and an inbound rule for the program's port
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("api", {
 *   sku: "Standard",
 *   allocationMethod: "Static",
 * });
 * const nsg = yield* Azure.Network.NetworkSecurityGroup("api", {});
 * yield* Azure.Network.SecurityRule("http", {
 *   networkSecurityGroup: nsg.networkSecurityGroupName,
 *   priority: 100,
 *   direction: "Inbound",
 *   access: "Allow",
 *   protocol: "Tcp",
 *   sourceAddressPrefix: "*",
 *   sourcePortRange: "*",
 *   destinationAddressPrefix: "*",
 *   destinationPortRange: "3000",
 * });
 * const nic = yield* Azure.Network.NetworkInterface("api", {
 *   ipConfigurations: [{ subnetId: subnet.subnetId, publicIpAddressId: ip.publicIpAddressId }],
 *   networkSecurityGroupId: nsg.networkSecurityGroupId,
 * });
 * ```
 *
 * ### Effect VMs
 * A VM that runs an Effect program is a class. Props describe the VM, and
 * the Effect is the program. `main: import.meta.url` makes the file both
 * the bundle entry and the program. Init binds resources; the returned
 * `fetch` runs per request.
 *
 * **Example:** Effect VM with an HTTP handler
 * ```typescript
 * // src/api.ts
 * import * as Azure from "@alchemy.run/azure";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Network } from "./network.ts";
 *
 * export default class Api extends Azure.Compute.VirtualMachine<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const { nic } = yield* Network;
 *     return {
 *       main: import.meta.url,
 *       vmSize: "Standard_B2ats_v2",
 *       networkInterfaceIds: [nic.networkInterfaceId],
 *       adminUsername: "azureuser",
 *       sshPublicKeys: [publicKey],
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello from a VM")),
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
 * **Example:** A background loop next to the HTTP server
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
 * ### Async VMs
 * You don't have to use Effect. Call the VM with `main` pointing at a plain
 * handler file and no implementation. Alchemy bundles that file as-is (no
 * Effect runtime in it) and serves its `fetch` with a Node HTTP server. The
 * `env` prop takes literals, `Config` values, and resources, and
 * {@link InferEnv} types the handler's `env` argument.
 *
 * **Example:** Declaring an async VM
 * ```typescript
 * // alchemy.run.ts
 * export const Hello = Effect.gen(function* () {
 *   const { nic } = yield* Network;
 *   return yield* Azure.Compute.VirtualMachine("Hello", {
 *     main: "./src/hello.ts",
 *     vmSize: "Standard_B2ats_v2",
 *     networkInterfaceIds: [nic.networkInterfaceId],
 *     adminUsername: "azureuser",
 *     sshPublicKeys: [publicKey],
 *     env: {
 *       GREETING: "hello",
 *       API_KEY: Config.redacted("API_KEY"),
 *       UPLOADS: yield* Uploads,
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
 * **Example:** Port, size, and bundle settings
 * ```typescript
 * export default class Api extends Azure.Compute.VirtualMachine<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     port: 8080,
 *     vmSize: "Standard_D2as_v5",
 *     osDiskStorageAccountType: "StandardSSD_LRS",
 *     build: { output: { sourcemap: true } },
 *     networkInterfaceIds: [nic.networkInterfaceId],
 *     adminUsername: "azureuser",
 *     sshPublicKeys: [publicKey],
 *   },
 *   program,
 * ) {}
 * ```
 *
 * ### Packaging
 * With `main`, Alchemy bundles the program and its imports with Rolldown
 * into one ESM file, `index.mjs`, for Node.js 22, next to a `package.json`.
 * No `node_modules` ship, so every import must be in the bundle. Alchemy
 * uploads the bundle and the program's env as one release blob to the
 * staging storage account. A managed run command downloads it with a
 * one-hour read SAS, unpacks it to `/opt/alchemy/<unit>/current`, and
 * restarts the systemd unit, which runs `node index.mjs`. The command
 * installs Node.js 22 under `/opt/alchemy` the first time. A deploy runs
 * the command again only when the bundle or the env changes. Pass Rolldown
 * options on `build`.
 *
 * **Example:** Mark more packages as side-effect free
 * ```typescript
 * export default class Api extends Azure.Compute.VirtualMachine<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     vmSize: "Standard_B1s",
 *     build: { pure: { packages: ["zod"] } },
 *     networkInterfaceIds: [nic.networkInterfaceId],
 *     adminUsername: "azureuser",
 *     sshPublicKeys: [publicKey],
 *   },
 *   program,
 * ) {}
 * ```
 *
 * ### Storage Bindings
 * Bindings grant the VM's managed identity the smallest data role on the
 * bound resource only, and hand the program a typed client. The program
 * calls Azure with the identity's tokens from the instance metadata
 * service. `BlobContainerReadWrite` grants **Storage Blob Data
 * Contributor** on the container.
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
 * const send = yield* Azure.Storage.QueueSend(jobs);
 *
 * // runtime
 * yield* send.send(JSON.stringify({ id: 1 }));
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
 * `QueueSend` grants **Azure Service Bus Data Sender** on the queue.
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
 * ### Cosmos DB Bindings
 * `SqlContainerReadWrite` assigns a Cosmos DB data-plane role scoped to the
 * one container.
 *
 * **Example:** Upsert a document
 * ```typescript
 * // init
 * const orders = yield* Azure.CosmosDB.SqlContainerReadWrite(ordersContainer);
 *
 * // runtime
 * yield* orders.upsert({
 *   document: { id: "o-1", tenant: "t1", status: "open" },
 *   partitionKey: ["t1"],
 * });
 * // …provided with Effect.provide(Azure.CosmosDB.SqlContainerReadWriteHttp)
 * ```
 *
 * ### Controlling the VM from a Runtime
 * `StartVirtualMachine`, `DeallocateVirtualMachine`, `RestartVirtualMachine`,
 * `PowerOffVirtualMachine`, `RedeployVirtualMachine`, and
 * `RunVirtualMachineCommand` let another runtime operate the VM. Each
 * grants a custom role with only its one action, on this VM only.
 *
 * **Example:** Start and stop a VM from a Function
 * ```typescript
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vm = yield* Vm;
 *     // init
 *     const start = yield* Azure.Compute.StartVirtualMachine(vm);
 *     const deallocate = yield* Azure.Compute.DeallocateVirtualMachine(vm);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const request = yield* HttpServerRequest;
 *         yield* request.url.endsWith("/stop") ? deallocate() : start();
 *         return HttpServerResponse.text("accepted");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(
 *     Effect.provide([
 *       Azure.Compute.StartVirtualMachineHttp,
 *       Azure.Compute.DeallocateVirtualMachineHttp,
 *     ]),
 *   ),
 * ) {}
 * ```
 *
 * ### Event Sources
 * A VM has no native triggers: Azure delivers nothing to it but network
 * traffic. Serve HTTP with `fetch`, or poll a queue from a `ServerHost`
 * loop with a receive binding.
 *
 * **Example:** Poll a Storage queue from a background loop
 * ```typescript
 * const inbox = yield* Azure.Storage.QueueReceive(jobs);
 * const host = yield* ServerHost;
 * yield* host.run(
 *   Effect.gen(function* () {
 *     const messages = yield* inbox.receive({ maxMessages: 16 });
 *     for (const message of messages) {
 *       yield* Effect.log(message.text);
 *       yield* inbox.delete(message);
 *     }
 *   }).pipe(Effect.orDie, Effect.repeat(Schedule.spaced("5 seconds")), Effect.asVoid),
 * );
 * ```
 *
 * @resource
 * @category Compute
 */
export const VirtualMachine: Platform<
  VirtualMachine,
  VirtualMachineServices,
  VirtualMachineShape,
  VirtualMachineRuntimeContext,
  {},
  VirtualMachineProps
> & {
  /**
   * Plain and async (no-impl) constructor: captures the `env` literal so
   * {@link InferEnv} types the handler's `env` argument.
   */
  <const Env extends Record<string, any>, PropsReq = never>(
    id: string,
    props:
      | InputProps<VirtualMachineProps<Env>>
      | Effect.Effect<InputProps<VirtualMachineProps<Env>>, never, PropsReq>,
  ): Effect.Effect<VirtualMachine<Env>, never, Providers | PropsReq>;
} = Platform(VirtualMachineTypeId, {
  createRuntimeContext: createHostRuntimeContext(VirtualMachineTypeId),
  transformProps: (id, props) => transformVirtualMachineProps(id, props),
});

export class VirtualMachineHostingMissing extends Data.TaggedError(
  "Azure.Compute.VirtualMachineHostingMissing",
)<{ virtualMachineName: string; message: string }> {}

export class VirtualMachineIdentityMissing extends Data.TaggedError(
  "Azure.Compute.VirtualMachineIdentityMissing",
)<{ virtualMachineName: string; message: string }> {}

export class VirtualMachineReleaseFailed extends Data.TaggedError(
  "Azure.Compute.VirtualMachineReleaseFailed",
)<{ virtualMachineName: string; message: string }> {}

type Observed = compute.GetVirtualMachineResponse;

const DEFAULT_IMAGE = {
  publisher: "Canonical",
  offer: "ubuntu-24_04-lts",
  sku: "server",
  version: "latest",
} as const;

const DEFAULT_PORT = 3000;
const NODE_VERSION = "22.20.0";
/** Managed run command that installs the program's release. */
const RELEASE_COMMAND = "alchemy-release";
const RELEASE_BLOB = "release.json";

const getVm = (subscriptionId: string, resourceGroupName: string, vmName: string) =>
  orUndefinedIfNotFound(compute.GetVirtualMachine({ subscriptionId, resourceGroupName, vmName }));

/** Program attributes carried over from the last reconcile. */
type ProgramAttrs = Pick<
  VirtualMachineAttributes,
  "privateIpAddress" | "publicIpAddress" | "port" | "url" | "unitName" | "codeHash" | "releaseHash"
>;

const programAttrsOf = (output: VirtualMachineAttributes | undefined): ProgramAttrs => ({
  privateIpAddress: output?.privateIpAddress,
  publicIpAddress: output?.publicIpAddress,
  port: output?.port,
  url: output?.url,
  unitName: output?.unitName,
  codeHash: output?.codeHash,
  releaseHash: output?.releaseHash,
});

const toAttrs = (
  resourceGroup: string,
  name: string,
  vm: Observed,
  program: ProgramAttrs = {},
): VirtualMachineAttributes => {
  const p = vm.properties;
  return {
    virtualMachineName: name,
    virtualMachineId: vm.id ?? "",
    vmId: p?.vmId,
    resourceGroup,
    location: vm.location,
    zones: [...(vm.zones ?? [])],
    vmSize: p?.hardwareProfile?.vmSize,
    computerName: p?.osProfile?.computerName,
    osDiskName: p?.storageProfile?.osDisk?.name,
    osDiskId: p?.storageProfile?.osDisk?.managedDisk?.id,
    networkInterfaceIds: (p?.networkProfile?.networkInterfaces ?? []).flatMap((nic) =>
      nic.id ? [nic.id] : [],
    ),
    principalId: vm.identity?.principalId,
    tenantId: vm.identity?.tenantId,
    timeCreated: p?.timeCreated,
    tags: userTags(vm.tags),
    ...program,
  };
};

const identityInput = (
  identity: VirtualMachineIdentity | undefined,
): compute.VirtualMachineIdentityInput | undefined => {
  if (identity === undefined) return undefined;
  const system = identity.systemAssigned ?? false;
  const users = identity.userAssignedIdentityIds ?? [];
  const type =
    system && users.length > 0
      ? "SystemAssigned, UserAssigned"
      : system
        ? "SystemAssigned"
        : users.length > 0
          ? "UserAssigned"
          : "None";
  return {
    type,
    userAssignedIdentities:
      users.length > 0 ? Object.fromEntries(users.map((userId) => [userId, {}])) : undefined,
  };
};

/** Normalised identity for observed-vs-desired comparison. */
const identityKey = (type: string | undefined, userIds: ReadonlyArray<string>) =>
  canonical({
    system: (type ?? "None").includes("SystemAssigned"),
    users: userIds.map((id) => id.toLowerCase()).sort(),
  });

const imageReference = (image: VirtualMachineImage | undefined): compute.ImageReferenceInput => {
  const value = image ?? DEFAULT_IMAGE;
  return "id" in value
    ? { id: value.id }
    : {
        publisher: value.publisher,
        offer: value.offer,
        sku: value.sku,
        version: value.version ?? "latest",
      };
};

/**
 * VMs are replaced delete-first: the replacement attaches the same network
 * interfaces, and a NIC belongs to at most one VM.
 */
const REPLACE = { action: "replace", deleteFirst: true } as const;

const envString = (value: unknown): string =>
  typeof value === "string" ? value : packEnvValue(value);

const collectBindings = (bindings: ResourceBinding<VirtualMachineBinding>[]) => {
  const env: Record<string, unknown> = {};
  const grants = new Map<string, VirtualMachineRoleAssignment>();
  const active = bindings.filter(
    (b: ResourceBinding<VirtualMachineBinding> & { action?: string }) => b.action !== "delete",
  );
  for (const binding of active) {
    Object.assign(env, binding.data.env ?? {});
    for (const grant of binding.data.roleAssignments ?? []) {
      grants.set(`${grant.scope.toLowerCase()}|${grant.roleDefinitionId.toLowerCase()}`, grant);
    }
  }
  return { env, grants: [...grants.values()] };
};

/** Generated entry of an Effect VM program: load env, run init, serve. */
const effectEntry = (handler: string) => (importPath: string) =>
  `
import { bootstrap, loadEnv } from "@alchemy.run/azure/Bootstrap/VirtualMachine";

globalThis.__ALCHEMY_RUNTIME__ = true;
loadEnv();
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});

await bootstrap(entrypoint);
`;

/** Generated entry of an async VM program: no Effect, just the handler file. */
const asyncEntry = (handler: string, envKeys: readonly string[]) => (importPath: string) =>
  `
import { loadEnv, serve } from "@alchemy.run/azure/Bootstrap/VirtualMachineAsync";

loadEnv();
const { ${handler}: handler } = await import(${JSON.stringify(importPath)});

serve(handler, ${JSON.stringify(envKeys)});
`;

const PACKAGE_JSON = `${JSON.stringify({ type: "module", main: "index.mjs" }, null, 2)}\n`;

const makeBundler = Effect.gen(function* () {
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
  return Effect.fn(function* (props: VirtualMachineProps & { main: string }) {
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
    const files = yield* Effect.sync(() => [
      ...output.files.map((file) => ({
        path: file.path,
        content:
          typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content,
      })),
      { path: "package.json", content: new TextEncoder().encode(PACKAGE_JSON) },
    ]);
    const codeHash = (yield* sha256Object({
      bundle: output.hash,
      package: PACKAGE_JSON,
      envKeys: props.isExternal ? envKeys : [],
    })).slice(0, 16);
    return { files, codeHash };
  });
});

/** systemd unit name for the program of resource `id`. */
const unitNameOf = (id: string) =>
  `alchemy-${id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)}`;

/**
 * The release script: install Node.js once, fetch the release from
 * `$RELEASE_URL` (a read SAS passed as a protected parameter), unpack it,
 * and (re)start the unit. The release hash makes each release a new script,
 * which is what re-runs the command.
 */
const releaseScript = (unitName: string, releaseHash: string) => {
  const app = `/opt/alchemy/${unitName}`;
  const nodeDir = `/opt/alchemy/node-v${NODE_VERSION}`;
  const unpack = [
    `const fs=require("fs"),path=require("path");`,
    `const [src,dir]=process.argv.slice(1);`,
    `const r=JSON.parse(fs.readFileSync(src,"utf8"));`,
    `for(const [p,b] of Object.entries(r.files)){const f=path.join(dir,p);`,
    `fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,Buffer.from(b,"base64"));}`,
    `fs.writeFileSync(path.join(dir,"env.json"),JSON.stringify(r.env),{mode:0o600});`,
  ].join("");
  return `#!/bin/bash
# alchemy release ${releaseHash}
set -euo pipefail
if [ ! -x ${nodeDir}/bin/node ]; then
  case "$(uname -m)" in
    x86_64) ARCH=x64 ;;
    aarch64) ARCH=arm64 ;;
    *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
  esac
  mkdir -p ${nodeDir}
  curl -fsSL --retry 5 --retry-delay 3 "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-$ARCH.tar.xz" -o /tmp/alchemy-node.tar.xz
  tar -xJf /tmp/alchemy-node.tar.xz -C ${nodeDir} --strip-components=1
  rm -f /tmp/alchemy-node.tar.xz
fi
mkdir -p ${app}
curl -fsSL --retry 5 --retry-delay 3 "$RELEASE_URL" -o ${app}/release.json
rm -rf ${app}/next
${nodeDir}/bin/node -e '${unpack}' ${app}/release.json ${app}/next
rm -f ${app}/release.json
rm -rf ${app}/current
mv ${app}/next ${app}/current
cat > /etc/systemd/system/${unitName}.service <<'UNIT'
[Unit]
Description=Alchemy program ${unitName}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${app}/current
ExecStart=${nodeDir}/bin/node ${app}/current/index.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable ${unitName}.service
systemctl restart ${unitName}.service
echo "release ${releaseHash} started"
`;
};

const getReleaseCommand = (subscriptionId: string, resourceGroupName: string, vmName: string) =>
  orUndefinedIfNotFound(
    compute.GetVirtualMachineRunCommandByVirtualMachine({
      subscriptionId,
      resourceGroupName,
      vmName,
      runCommandName: RELEASE_COMMAND,
      _expand: "instanceView",
    }),
  );

const TERMINAL_EXECUTION = new Set(["Succeeded", "Failed", "TimedOut", "Canceled"]);

class ReleasePending extends Data.TaggedError("ReleasePending")<{}> {}

/** One-hour SAS for the release blob. */
const releaseSas = Effect.fn(function* (
  subscriptionId: string,
  hosting: VirtualMachineHosting,
  permission: string,
) {
  const now = yield* Effect.sync(() => Date.now());
  const expiry = new Date(now + 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const { serviceSasToken } = yield* storage.ListStorageAccountServiceSAS({
    subscriptionId,
    resourceGroupName: hosting.resourceGroup,
    accountName: hosting.storageAccountName,
    canonicalizedResource: `/blob/${hosting.storageAccountName}/${hosting.containerName}/${RELEASE_BLOB}`,
    signedResource: "b",
    signedPermission: permission,
    signedProtocol: "https",
    signedExpiry: expiry,
  });
  return serviceSasToken;
});

/**
 * Stage the release in blob storage and install it with the managed run
 * command, unless the command already ran this exact release successfully.
 */
const deployRelease = Effect.fn(function* (options: {
  subscriptionId: string;
  resourceGroup: string;
  vmName: string;
  location: string;
  hosting: VirtualMachineHosting;
  unitName: string;
  releaseHash: string;
  release: Uint8Array;
}) {
  const { subscriptionId, resourceGroup, vmName, hosting } = options;
  const script = releaseScript(options.unitName, options.releaseHash);
  const get = getReleaseCommand(subscriptionId, resourceGroup, vmName);

  // Observe: skip when this release already ran to success on this VM.
  const observed = yield* get;
  const observedProps = observed?.properties;
  if (
    observedProps?.source?.script === script &&
    observedProps.provisioningState === "Succeeded" &&
    observedProps.instanceView?.executionState === "Succeeded"
  ) {
    return;
  }

  const writeSas = yield* releaseSas(subscriptionId, hosting, "cw");
  const readSas = yield* releaseSas(subscriptionId, hosting, "r");
  if (writeSas === undefined || readSas === undefined) {
    return yield* new VirtualMachineReleaseFailed({
      virtualMachineName: vmName,
      message: `Azure returned no SAS token for ${hosting.storageAccountName}`,
    });
  }
  const endpoint = hosting.blobEndpoint.replace(/\/+$/, "");
  yield* blob.UploadBlockBlob({
    url: `${endpoint}?${writeSas}`,
    containerName: hosting.containerName,
    blob: RELEASE_BLOB,
    body: options.release,
    xMsBlobContentType: "application/json",
  });

  const previousEnd = observedProps?.instanceView?.endTime;
  yield* compute
    .VirtualMachineRunCommandsCreateOrUpdate({
      subscriptionId,
      resourceGroupName: resourceGroup,
      vmName,
      runCommandName: RELEASE_COMMAND,
      location: options.location,
      properties: {
        source: { script },
        protectedParameters: [
          {
            name: "RELEASE_URL",
            value: `${endpoint}/${hosting.containerName}/${RELEASE_BLOB}?${readSas}`,
          },
        ],
        asyncExecution: false,
        timeoutInSeconds: 900,
        // The deploy reads the outcome itself to report the script's stderr.
        treatFailureAsDeploymentFailure: false,
      },
    })
    .pipe(Effect.retry(whileComputeBusy));

  // Wait for this script's run (not the previous run's instance view) to end.
  const finished = yield* get.pipe(
    Effect.flatMap((command) => {
      const props = command?.properties;
      const state = props?.instanceView?.executionState;
      const fresh =
        props?.source?.script === script &&
        (previousEnd === undefined || props.instanceView?.endTime !== previousEnd);
      return command !== undefined && fresh && state !== undefined && TERMINAL_EXECUTION.has(state)
        ? Effect.succeed(command)
        : Effect.fail(new ReleasePending());
    }),
    Effect.retry({
      while: (e) => e._tag === "ReleasePending",
      schedule: Schedule.spaced("5 seconds"),
      times: 180,
    }),
    Effect.catchTag("ReleasePending", () =>
      Effect.fail(
        new VirtualMachineReleaseFailed({
          virtualMachineName: vmName,
          message: `release ${options.releaseHash} did not finish within 15 minutes`,
        }),
      ),
    ),
  );
  const view = finished.properties?.instanceView;
  if (view?.executionState !== "Succeeded" || (view.exitCode ?? 0) !== 0) {
    return yield* new VirtualMachineReleaseFailed({
      virtualMachineName: vmName,
      message: `release ${options.releaseHash} ended ${view?.executionState ?? "unknown"} (exit ${view?.exitCode ?? "?"}): ${(view?.error ?? view?.output ?? "").slice(-1000)}`,
    });
  }
});

/** `{ resourceGroup, name }` of an ARM ID's last segment. */
const armRef = (armId: string) => ({
  resourceGroup: resourceGroupOf(armId),
  name: armId.split("/").pop(),
});

/** Private and public IP of the VM's primary NIC. */
const primaryAddresses = Effect.fn(function* (subscriptionId: string, nicIds: string[]) {
  const none: Pick<ProgramAttrs, "privateIpAddress" | "publicIpAddress"> = {};
  const nicId = nicIds[0];
  if (nicId === undefined) return none;
  const nicRef = armRef(nicId);
  if (nicRef.resourceGroup === undefined || nicRef.name === undefined) return none;
  const nic = yield* orUndefinedIfNotFound(
    network.GetNetworkInterface({
      subscriptionId,
      resourceGroupName: nicRef.resourceGroup,
      networkInterfaceName: nicRef.name,
    }),
  );
  const configs = nic?.properties?.ipConfigurations ?? [];
  const primary = configs.find((c) => c.properties?.primary === true) ?? configs[0];
  const privateIpAddress = primary?.properties?.privateIPAddress;
  const publicId = primary?.properties?.publicIPAddress?.id;
  if (publicId === undefined) return { ...none, privateIpAddress };
  const ipRef = armRef(publicId);
  if (ipRef.resourceGroup === undefined || ipRef.name === undefined) {
    return { ...none, privateIpAddress };
  }
  const ip = yield* orUndefinedIfNotFound(
    network.GetPublicIPAddress({
      subscriptionId,
      resourceGroupName: ipRef.resourceGroup,
      publicIpAddressName: ipRef.name,
    }),
  );
  return { privateIpAddress, publicIpAddress: ip?.properties?.ipAddress };
});

export const VirtualMachineProvider = () =>
  Provider.effect(
    VirtualMachine,
    Effect.gen(function* () {
      const bundle = yield* makeBundler;

      return VirtualMachine.Provider.of({
        stables: [
          "virtualMachineName",
          "virtualMachineId",
          "vmId",
          "resourceGroup",
          "location",
          "osDiskName",
          "osDiskId",
          "timeCreated",
        ],

        list: Effect.fn(function* () {
          const { subscriptionId } = yield* AzureEnvironment.current;
          const page = yield* collectAll(compute.ListVirtualMachineAll, { subscriptionId });
          return page.value.flatMap((vm) => {
            const resourceGroup = resourceGroupOf(vm.id);
            return hasAnyAlchemyTag(vm.tags) && resourceGroup !== undefined && vm.name !== undefined
              ? [toAttrs(resourceGroup, vm.name, vm)]
              : [];
          });
        }),

        diff: Effect.fn(function* ({ news, olds, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          const props = news as VirtualMachineProps;
          if (
            (props.resourceGroup !== undefined &&
              !sameId(props.resourceGroup, output.resourceGroup)) ||
            (props.name !== undefined && !sameId(props.name, output.virtualMachineName)) ||
            (props.location !== undefined && !sameId(props.location, output.location)) ||
            !sameSet(props.zones, output.zones) ||
            !sameSet(props.networkInterfaceIds, output.networkInterfaceIds) ||
            (props.computerName !== undefined && props.computerName !== output.computerName)
          ) {
            return REPLACE;
          }
          // Immutable-after-create inputs that Azure does not echo back.
          const immutable = (p: VirtualMachineProps) =>
            canonical({
              image: imageReference(p.image),
              osDiskStorageAccountType: p.osDiskStorageAccountType ?? "Standard_LRS",
              osDiskSizeGB: p.osDiskSizeGB,
              adminUsername: p.adminUsername,
              sshPublicKeys: p.sshPublicKeys ?? [],
              customData: p.customData,
              securityType: p.securityType,
              availabilitySetId: p.availabilitySetId?.toLowerCase(),
              proximityPlacementGroupId: p.proximityPlacementGroupId?.toLowerCase(),
              hostId: p.hostId?.toLowerCase(),
              hostGroupId: p.hostGroupId?.toLowerCase(),
              capacityReservationGroupId: p.capacityReservationGroupId?.toLowerCase(),
              priority: p.priority ?? "Regular",
              evictionPolicy: p.evictionPolicy,
            });
          if (olds !== undefined && immutable(props) !== immutable(olds)) {
            return REPLACE;
          }
          if (
            olds !== undefined &&
            (props.adminPassword === undefined) !== (olds.adminPassword === undefined)
          ) {
            return REPLACE;
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
            output?.virtualMachineName ?? olds?.name ?? (yield* createComputeName(id, 64));
          const observed = yield* getVm(subscriptionId, resourceGroup, name);
          if (observed === undefined) return undefined;
          const attrs = toAttrs(resourceGroup, name, observed, programAttrsOf(output));
          return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
          const env = yield* AzureEnvironment.current;
          const { subscriptionId } = env;
          yield* ensureRegistered(subscriptionId, "Microsoft.Compute");
          const name =
            news.name ?? output?.virtualMachineName ?? (yield* createComputeName(id, 64));
          const resourceGroup = news.resourceGroup;
          if (resourceGroup === undefined) {
            return yield* new VirtualMachineHostingMissing({
              virtualMachineName: name,
              message: `Azure.Compute.VirtualMachine "${id}" has no resource group`,
            });
          }
          const main = news.main;
          const hosting = news.hosting;
          if (main !== undefined && hosting === undefined) {
            return yield* new VirtualMachineHostingMissing({
              virtualMachineName: name,
              message: `Azure.Compute.VirtualMachine "${id}" has no release storage`,
            });
          }
          const location = news.location ?? output?.location ?? env.location;
          const tags = yield* desiredTags(id, news.tags);
          const vmSize = news.vmSize;
          const bootDiagnostics = news.bootDiagnostics ?? false;
          // A program runs as the VM's system-assigned identity.
          const identity: VirtualMachineIdentity | undefined =
            main !== undefined ? { ...news.identity, systemAssigned: true } : news.identity;
          const where = {
            subscriptionId,
            resourceGroupName: resourceGroup,
            vmName: name,
          };
          const label = `virtual machine ${name}`;
          const get = getVm(subscriptionId, resourceGroup, name);

          // Observe.
          let observed = yield* get;

          // Ensure. The PUT returns 201 and provisioning continues in the
          // background; poll until the VM reports Succeeded.
          if (observed === undefined) {
            const sshKeys = news.sshPublicKeys ?? [];
            yield* compute
              .VirtualMachinesCreateOrUpdate({
                ...where,
                location,
                tags,
                zones: news.zones,
                identity: identityInput(identity),
                properties: {
                  hardwareProfile: { vmSize },
                  storageProfile: {
                    imageReference: imageReference(news.image),
                    osDisk: {
                      createOption: "FromImage",
                      deleteOption: "Delete",
                      diskSizeGB: news.osDiskSizeGB,
                      managedDisk: {
                        storageAccountType: news.osDiskStorageAccountType ?? "Standard_LRS",
                      },
                    },
                  },
                  osProfile: {
                    computerName: news.computerName ?? name,
                    adminUsername: news.adminUsername,
                    adminPassword: news.adminPassword,
                    customData: news.customData,
                    linuxConfiguration:
                      sshKeys.length > 0
                        ? {
                            disablePasswordAuthentication: news.adminPassword === undefined,
                            ssh: {
                              publicKeys: sshKeys.map((keyData) => ({
                                path: `/home/${news.adminUsername}/.ssh/authorized_keys`,
                                keyData,
                              })),
                            },
                          }
                        : undefined,
                  },
                  networkProfile: {
                    networkInterfaces: news.networkInterfaceIds.map((nicId, index) => ({
                      id: nicId,
                      properties: {
                        primary: index === 0,
                        deleteOption: "Detach",
                      },
                    })),
                  },
                  securityProfile:
                    news.securityType === undefined
                      ? undefined
                      : { securityType: news.securityType },
                  diagnosticsProfile: {
                    bootDiagnostics: { enabled: bootDiagnostics },
                  },
                  availabilitySet: ref(news.availabilitySetId),
                  proximityPlacementGroup: ref(news.proximityPlacementGroupId),
                  host: ref(news.hostId),
                  hostGroup: ref(news.hostGroupId),
                  capacityReservation:
                    news.capacityReservationGroupId === undefined
                      ? undefined
                      : {
                          capacityReservationGroup: ref(news.capacityReservationGroupId),
                        },
                  priority: news.priority,
                  evictionPolicy: news.evictionPolicy,
                  billingProfile:
                    news.maxPrice === undefined ? undefined : { maxPrice: news.maxPrice },
                  licenseType: news.licenseType,
                  userData: news.userData,
                },
              })
              .pipe(Effect.retry(whileComputeBusy));
          }
          observed = yield* waitComputeProvisioned(label, get);

          // Sync each mutable aspect against observed state; PATCH only deltas.
          const p = observed.properties;
          const patch: compute.VirtualMachinePropertiesInput = {};
          if (p?.hardwareProfile?.vmSize !== vmSize) {
            patch.hardwareProfile = { vmSize };
          }
          if ((p?.diagnosticsProfile?.bootDiagnostics?.enabled ?? false) !== bootDiagnostics) {
            patch.diagnosticsProfile = {
              bootDiagnostics: { enabled: bootDiagnostics },
            };
          }
          if (news.maxPrice !== undefined && p?.billingProfile?.maxPrice !== news.maxPrice) {
            patch.billingProfile = { maxPrice: news.maxPrice };
          }
          if (news.licenseType !== undefined && p?.licenseType !== news.licenseType) {
            patch.licenseType = news.licenseType;
          }
          // userData is only returned with `$expand=userData`.
          if (news.userData !== undefined) {
            const withUserData = yield* compute.GetVirtualMachine({
              ...where,
              _expand: "userData",
            });
            if (withUserData.properties?.userData !== news.userData) {
              patch.userData = news.userData;
            }
          }
          const desiredIdentity = identityInput(identity);
          const identityChanged =
            desiredIdentity !== undefined &&
            identityKey(
              observed.identity?.type,
              Object.keys(observed.identity?.userAssignedIdentities ?? {}),
            ) !== identityKey(desiredIdentity.type, identity?.userAssignedIdentityIds ?? []);
          const tagsChanged = tagsDiffer(observed.tags, tags);
          if (Object.keys(patch).length > 0 || identityChanged || tagsChanged) {
            yield* compute
              .UpdateVirtualMachine({
                ...where,
                tags: tagsChanged ? tags : undefined,
                identity: identityChanged ? desiredIdentity : undefined,
                properties: Object.keys(patch).length > 0 ? patch : undefined,
              })
              .pipe(Effect.retry(whileComputeBusy));
            observed = yield* waitComputeProvisioned(label, get);
          }

          // Sync the binding grants on the system-assigned identity.
          const collected = collectBindings(bindings as ResourceBinding<VirtualMachineBinding>[]);
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
            return yield* new VirtualMachineIdentityMissing({
              virtualMachineName: name,
              message: `virtual machine ${name} needs a system-assigned identity for its role assignments`,
            });
          }

          const observedNics = (p?.networkProfile?.networkInterfaces ?? []).flatMap((nic) =>
            nic.id ? [nic.id] : [],
          );
          const addresses = yield* primaryAddresses(
            subscriptionId,
            observedNics.length > 0 ? observedNics : news.networkInterfaceIds,
          );
          if (main === undefined || hosting === undefined) {
            return toAttrs(resourceGroup, name, observed, addresses);
          }

          // Deploy the program: bundle + env → one release.
          const stack = yield* Stack;
          const port = news.port ?? DEFAULT_PORT;
          const programEnv: Record<string, string> = {
            ALCHEMY_STACK_NAME: stack.name,
            ALCHEMY_STAGE: stack.stage,
            ALCHEMY_PHASE: "runtime",
            PORT: String(port),
          };
          for (const [key, value] of Object.entries({ ...collected.env, ...news.env })) {
            if (value !== undefined) programEnv[key] = envString(value);
          }
          const { files, codeHash } = yield* bundle({ ...news, main });
          const releaseHash = (yield* sha256Object({ codeHash, env: programEnv })).slice(0, 16);
          const release = yield* Effect.sync(() =>
            new TextEncoder().encode(
              JSON.stringify({
                files: Object.fromEntries(
                  files.map((file) => [file.path, Buffer.from(file.content).toString("base64")]),
                ),
                env: programEnv,
              }),
            ),
          );
          const unitName = output?.unitName ?? unitNameOf(id);
          yield* deployRelease({
            subscriptionId,
            resourceGroup,
            vmName: name,
            location: observed.location,
            hosting,
            unitName,
            releaseHash,
            release,
          });

          return toAttrs(resourceGroup, name, observed, {
            ...addresses,
            port,
            url:
              addresses.publicIpAddress === undefined
                ? undefined
                : `http://${addresses.publicIpAddress}:${port}`,
            unitName,
            codeHash,
            releaseHash,
          });
        }),

        delete: Effect.fn(function* ({ id, output }) {
          const { subscriptionId } = yield* AzureEnvironment.current;
          const get = getVm(subscriptionId, output.resourceGroup, output.virtualMachineName);
          // Role assignments outlive their principal; revoke them first.
          const observed = yield* get;
          const principalId = observed?.identity?.principalId ?? output.principalId;
          if (principalId !== undefined) {
            yield* syncBindingAssignments({
              id,
              subscriptionId,
              appId: observed?.id ?? output.virtualMachineId,
              principalId,
              grants: [],
            });
          }
          yield* ignoreNotFound(
            compute.DeleteVirtualMachine({
              subscriptionId,
              resourceGroupName: output.resourceGroup,
              vmName: output.virtualMachineName,
            }),
          ).pipe(Effect.retry(whileComputeBusy));
          yield* waitComputeGone(`virtual machine ${output.virtualMachineName}`, get);
        }),

        nuke: {
          dependsOn: [
            "Azure.Resources.ResourceGroup",
            "Azure.Network.NetworkInterface",
            "Azure.Compute.AvailabilitySet",
            "Azure.Compute.ProximityPlacementGroup",
          ],
        },
      });
    }),
  );
