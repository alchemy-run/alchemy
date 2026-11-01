import * as iaas from "@distilled.cloud/stackit/iaas";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { recordsEqual } from "alchemy/Util/equal";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { childrenLeftAfterSettling, waitFor, waitUntilGone } from "../internal/wait.ts";
import { desiredGenerationLabels, hasAlchemyLabels, stripInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listServerBackupObjects } from "../ServerBackup/internal.ts";
import {
  conflictRetry,
  findOwnedByName,
  iaasName,
  labelsPatch,
  ownedOnly,
  projectScopeChanged,
  readGeneration,
  resolveProjectScope,
  type ProjectScope,
  type ProjectScopedProps,
} from "./internal.ts";

/** The create response of a server carried no id. */
export class ServerIdMissing extends Data.TaggedError("Stackit.IaaS.ServerIdMissing")<{
  readonly resourceName: string;
  readonly message: string;
}> {}

/**
 * The server still has backups or backup schedules, which a delete would make unreachable: the
 * Server Backup API only reaches them through their server.
 */
export class ServerHasBackups extends Data.TaggedError("Stackit.IaaS.ServerHasBackups")<{
  readonly serverId: string;
  readonly schedules: ReadonlyArray<string>;
  readonly backups: ReadonlyArray<string>;
  readonly message: string;
}> {}

/** Boot disk of a server, created (or taken over) at server creation. */
export interface ServerBootVolume {
  /**
   * Where the boot disk comes from: an `image` (a new volume is created
   * from it), an existing `volume`, or a `snapshot`/`backup` to restore.
   */
  source: {
    /** Kind of source. */
    type: "image" | "volume" | "snapshot" | "backup";
    /** Id of the image, volume, snapshot or backup. */
    id: string;
  };
  /** Size of the new boot volume in GB. Ignored for a `volume` source. */
  size?: number;
  /** Performance class of the new boot volume. */
  performanceClass?: string;
  /**
   * Delete the boot volume together with the server.
   * @default `true`, except for a `volume` source (an existing volume is kept)
   */
  deleteOnTermination?: boolean;
}

/** Initial network attachment of a server. */
export type ServerNetworking =
  | {
      /** Attach a new network interface in this network. */
      networkId: string;
    }
  | {
      /** Attach these existing network interfaces (`NetworkInterface`). */
      networkInterfaceIds: string[];
    };

/** STACKIT server agent options. */
export interface ServerAgentOptions {
  /** Install the STACKIT server agent on first boot. */
  provisioned?: boolean;
  /** Let the platform collect guest metrics (requires the agent). */
  vmMonitoring?: boolean;
}

/** Power state Alchemy converges the server to. */
export type ServerDesiredStatus = "active" | "inactive" | "deallocated";

export interface ServerProps extends ProjectScopedProps {
  /**
   * Name of the server (also its hostname). Updated in place.
   * @default a physical name generated from the app, stage and logical id
   */
  name?: string;
  /**
   * Machine type (flavor), e.g. `g1.1` (1 vCPU, 4 GB) or `c1.2`. Changing
   * it resizes the server in place, which restarts it. List the types of a
   * region with `listMachineTypes`.
   */
  machineType: string;
  /**
   * Boot from this image directly, on the machine type's local disk. Use
   * `bootVolume` instead for a network volume. Changing it replaces the
   * server.
   */
  imageId?: string;
  /** Boot from a network volume. Changing it replaces the server. */
  bootVolume?: ServerBootVolume;
  /**
   * Initial network attachment: a new interface in a network, or existing
   * network interfaces. Further interfaces attach with
   * `ServerNetworkInterfaceAttachment`. Changing it replaces the server.
   */
  networking?: ServerNetworking;
  /**
   * Availability zone, e.g. `eu01-1`. Changing it replaces the server.
   * @default the boot volume's zone, else the metro zone
   */
  availabilityZone?: string;
  /** Affinity group id (`AffinityGroup`). Changing it replaces the server. */
  affinityGroup?: string;
  /** Name of a `KeyPair` installed for SSH login. Changing it replaces the server. */
  keypairName?: string;
  /**
   * Cloud-init user data (a script or `#cloud-config` document), as plain
   * text; Alchemy base64-encodes it. Changing it replaces the server.
   */
  userData?: string;
  /** STACKIT server agent options. Changing them replaces the server. */
  agent?: ServerAgentOptions;
  /** Attach a cloud-init config drive. Changing it replaces the server. */
  configDrive?: boolean;
  /** Free-form metadata. Updated in place; unmanaged when omitted. */
  metadata?: Record<string, string>;
  /**
   * Power state to converge to: `active` (running), `inactive` (stopped,
   * still billed for its resources) or `deallocated` (stopped and released
   * from its host). Unmanaged when omitted; a new server always starts
   * `active`.
   */
  desiredStatus?: ServerDesiredStatus;
  /**
   * Allow deleting the server, and with it replacing it, while STACKIT Server Backup still holds
   * backups or schedules for it. They can't be reached once the server is gone. Without this, such
   * a delete stops with `Stackit.IaaS.ServerHasBackups`. Deploy it before the change that replaces
   * the server: an old server keeps the props it was deployed with.
   *
   * @default false
   */
  forceDestroy?: boolean;
  /**
   * Project of the server. Defaults to the profile's project. Changing it
   * replaces the server.
   */
  projectId?: string;
  /**
   * Region of the server. Defaults to the profile's region. Changing it
   * replaces the server.
   */
  region?: string;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`) are added automatically.
   */
  labels?: Record<string, string>;
}

/** A network interface attached to a server. */
export interface ServerNetworkInterface {
  /** Network interface id. */
  networkInterfaceId: string;
  /** Network of the interface. */
  networkId: string;
  /** Name of the network. */
  networkName: string;
  /** Private IPv4 address. */
  ipv4: string | undefined;
  /** IPv6 address. */
  ipv6: string | undefined;
  /** MAC address. */
  mac: string;
  /** Public IP associated with the interface, if any. */
  publicIp: string | undefined;
}

export interface ServerAttributes {
  /** Server id (UUID). */
  serverId: string;
  /** Name of the server. */
  name: string;
  /** Project of the server. */
  projectId: string;
  /** Region of the server. */
  region: string;
  /** Machine type. */
  machineType: string;
  /** Availability zone the server runs in. */
  availabilityZone: string | undefined;
  /** Image the server booted from (direct image boot). */
  imageId: string | undefined;
  /** Id of the boot volume, when booting from a volume. */
  bootVolumeId: string | undefined;
  /** SSH key pair installed at creation. */
  keypairName: string | undefined;
  /** Affinity group id. */
  affinityGroup: string | undefined;
  /** Lifecycle status, e.g. `ACTIVE`, `INACTIVE` or `DEALLOCATED`. */
  status: string | undefined;
  /** Power status reported by the hypervisor. */
  powerStatus: string | undefined;
  /** Attached network interfaces. */
  networkInterfaces: ServerNetworkInterface[];
  /** Ids of attached volumes (the boot volume included). */
  volumes: string[];
  /** Free-form metadata. */
  metadata: Record<string, string>;
  /** User labels (Alchemy's ownership labels stripped). */
  labels: Record<string, string>;
}

export type Server = Resource<
  "Stackit.IaaS.Server",
  ServerProps,
  ServerAttributes,
  never,
  Providers
>;

/**
 * A STACKIT virtual machine. Alchemy creates it, waits until it is
 * `ACTIVE`, and keeps its name, labels, metadata, machine type and power
 * state converged.
 *
 * A server boots from an image (`imageId`, on the machine type's local
 * disk) or from a network volume (`bootVolume`), and starts with one
 * network attachment (`networking`). Add further interfaces, volumes,
 * security groups or a service account with the attachment resources
 * (`ServerNetworkInterfaceAttachment`, `VolumeAttachment`,
 * `ServerSecurityGroupAttachment`, `ServerServiceAccountAttachment`), and a
 * public address with `PublicIp`. Servers are billed per hour by machine
 * type while they exist (`deallocated` stops the compute charge).
 *
 * ### Creating a server
 * **Example:** An Ubuntu server booting from a network volume
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const key = yield* Stackit.IaaS.KeyPair("Admin", {
 *   publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... admin@laptop",
 * });
 * const server = yield* Stackit.IaaS.Server("Web", {
 *   machineType: "g1.1",
 *   bootVolume: {
 *     size: 20,
 *     source: { type: "image", id: "<ubuntu 24.04 image id>" },
 *   },
 *   networking: { networkId: network.networkId },
 *   keypairName: key.name,
 *   labels: { role: "web" },
 * });
 * ```
 *
 * ### Bootstrapping with cloud-init
 * **Example:** Install a package on first boot
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const server = yield* Stackit.IaaS.Server("Web", {
 *   machineType: "g1.1",
 *   bootVolume: { size: 20, source: { type: "image", id: "<image id>" } },
 *   networking: { networkId: network.networkId },
 *   userData: `#cloud-config
 * packages:
 *   - nginx
 * `,
 * });
 * ```
 *
 * ### Exposing it on the internet
 * **Example:** A public IP on the server's interface
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const nic = yield* Stackit.IaaS.NetworkInterface("Web", {
 *   networkId: network.networkId,
 * });
 * const server = yield* Stackit.IaaS.Server("Web", {
 *   machineType: "g1.1",
 *   bootVolume: { size: 20, source: { type: "image", id: "<image id>" } },
 *   networking: { networkInterfaceIds: [nic.networkInterfaceId] },
 * });
 * const ip = yield* Stackit.IaaS.PublicIp("Web", {
 *   networkInterfaceId: nic.networkInterfaceId,
 * });
 * ```
 *
 * ### Resizing and power state
 * **Example:** Resize and stop the compute charge
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const server = yield* Stackit.IaaS.Server("Batch", {
 *   machineType: "c1.4", // was "c1.2": resized in place (restarts)
 *   bootVolume: { size: 20, source: { type: "image", id: "<image id>" } },
 *   networking: { networkId: network.networkId },
 *   desiredStatus: "deallocated",
 * });
 * ```
 *
 * ### Replacement
 * Changing `imageId`, `bootVolume`, `networking`, `availabilityZone`,
 * `affinityGroup`, `keypairName`, `userData`, `agent`, `configDrive`,
 * `projectId` or `region` creates a new server and deletes the old one,
 * including when `name` stays the same. A replacement that keeps a
 * `networkInterfaceIds` entry or a `volume` boot source deletes the old
 * server first, since those attach to one server at a time. The old boot
 * volume is deleted with it unless `bootVolume.deleteOnTermination` is
 * `false`; keep data on a separate `Volume` attached with `VolumeAttachment`.
 *
 * STACKIT Server Backup only reaches a backup through its server, so a delete of
 * a server that still has backups or backup schedules stops with
 * `Stackit.IaaS.ServerHasBackups`. A destroy deletes the stack's own first, so
 * only what the stack doesn't hold can stop it. A replacement that deletes the
 * old server first would lose them all, so its plan fails before anything
 * changes. To go ahead, deploy `forceDestroy: true` on its own, then make the
 * change.
 *
 * Power actions that are not a state (reboot, rescue, console access) are
 * not resource properties; they are runtime operations on the server.
 *
 * To run your own program on a server, deploy a `Stackit.IaaS.Service` on it.
 *
 * @resource
 * @product STACKIT Compute Engine
 * @category IaaS
 */
export const Server = Resource<Server>("Stackit.IaaS.Server");

/** Typical create time is 1-3 minutes; volume-backed boots of large images take longer. */
const READY_TIMEOUT = "15 minutes";

const SETTLED = new Set(["ACTIVE", "INACTIVE", "DEALLOCATED", "RESCUE"]);

const isSettled = (server: iaas.ServerOutput) => SETTLED.has(server.status ?? "");

const hasFailed = (server: iaas.ServerOutput) =>
  server.status === "ERROR"
    ? `${server.status}${server.errorMessage ? `: ${server.errorMessage}` : ""}`
    : undefined;

const statusOf: Record<ServerDesiredStatus, string> = {
  active: "ACTIVE",
  inactive: "INACTIVE",
  deallocated: "DEALLOCATED",
};

/** Plain string record of a free-form metadata object. */
const metadataRecord = (metadata: unknown): Record<string, string> => {
  if (metadata === null || typeof metadata !== "object") return {};
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined && value !== null) record[key] = String(value);
  }
  return record;
};

const toAttrs = (
  server: iaas.ServerOutput,
  scope: ProjectScope,
  name: string,
): ServerAttributes => ({
  serverId: server.id ?? "",
  name: server.name ?? name,
  ...scope,
  machineType: server.machineType,
  availabilityZone: server.availabilityZone,
  imageId: server.imageId,
  bootVolumeId: server.bootVolume?.id,
  keypairName: server.keypairName,
  affinityGroup: server.affinityGroup,
  status: server.status,
  powerStatus: server.powerStatus,
  networkInterfaces: (server.nics ?? []).map((nic) => ({
    networkInterfaceId: nic.nicId,
    networkId: nic.networkId,
    networkName: nic.networkName,
    ipv4: nic.ipv4,
    ipv6: nic.ipv6,
    mac: nic.mac,
    publicIp: nic.publicIp,
  })),
  volumes: [...(server.volumes ?? [])],
  metadata: metadataRecord(server.metadata),
  labels: stripInternalLabels(server.labels),
});

const getServer = (scope: ProjectScope, serverId: string) =>
  iaas
    .getServer({ ...scope, serverId, details: true })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const networkingCompatible = (
  networking: ServerNetworking | undefined,
  server: iaas.ServerOutput,
) => {
  if (networking === undefined) return true;
  const nics = server.nics ?? [];
  return "networkId" in networking
    ? nics.some((nic) => nic.networkId === networking.networkId)
    : networking.networkInterfaceIds.every((id) => nics.some((nic) => nic.nicId === id));
};

/**
 * A listed server can take the desired props in place. `userData`, `agent`,
 * `configDrive` and an image-backed `bootVolume` can't be observed; the
 * generation label rules out a replaced server instead.
 */
const compatible = (news: ServerProps) => (server: iaas.ServerOutput) =>
  (news.imageId === undefined || server.imageId === news.imageId) &&
  server.keypairName === news.keypairName &&
  server.affinityGroup === news.affinityGroup &&
  (news.availabilityZone === undefined || server.availabilityZone === news.availabilityZone) &&
  networkingCompatible(news.networking, server) &&
  (news.bootVolume?.source.type !== "volume" ||
    server.bootVolume?.id === news.bootVolume.source.id);

const observe = Effect.fn(function* (args: {
  id: string;
  name: string;
  scope: ProjectScope;
  serverId: string | undefined;
  news: ServerProps | undefined;
  instanceId: string | undefined;
}) {
  if (args.serverId !== undefined) {
    const byId = yield* getServer(args.scope, args.serverId);
    if (byId !== undefined) return byId;
  }
  // Crash recovery: a create whose state was never persisted.
  const { items } = yield* iaas.listServers({ ...args.scope, details: true });
  return yield* findOwnedByName(args.id, args.name, items, {
    instanceId: args.instanceId,
    compatible: args.news === undefined ? undefined : compatible(args.news),
  });
});

const toNetworking = (
  networking: ServerNetworking | undefined,
): iaas.CreateServerRequestNetworking =>
  networking === undefined
    ? {}
    : "networkId" in networking
      ? { networkId: networking.networkId }
      : { nicIds: networking.networkInterfaceIds };

const toBootVolume = (
  bootVolume: ServerBootVolume | undefined,
): iaas.BootVolumeInput | undefined =>
  bootVolume === undefined
    ? undefined
    : {
        source: bootVolume.source,
        size: bootVolume.size,
        performanceClass: bootVolume.performanceClass,
        deleteOnTermination: bootVolume.deleteOnTermination ?? bootVolume.source.type !== "volume",
      };

/** Refuse a delete that would strand what Server Backup holds. Nothing else lists it. */
const notEmptyError = (
  target: { projectId: string; region: string; serverId: string },
  objects: { schedules: ReadonlyArray<{ name: string }>; backups: ReadonlyArray<{ name: string }> },
  remedy: string,
) => {
  const schedules = objects.schedules.map(({ name }) => name);
  const backups = objects.backups.map(({ name }) => name);
  return new ServerHasBackups({
    serverId: target.serverId,
    schedules,
    backups,
    message: `Server ${target.serverId} has backup schedules (${schedules.join(", ") || "none"}) and backups (${backups.join(", ") || "none"}), which can't be reached once it is deleted. ${remedy}`,
  });
};

/** Canonical key of the create-only aspects of a server's props. */
const createOnlyKey = (props: ServerProps) =>
  JSON.stringify([
    props.imageId ?? null,
    props.bootVolume === undefined
      ? null
      : [
          props.bootVolume.source.type,
          props.bootVolume.source.id,
          props.bootVolume.size ?? null,
          props.bootVolume.performanceClass ?? null,
          props.bootVolume.deleteOnTermination ?? null,
        ],
    props.networking === undefined
      ? null
      : "networkId" in props.networking
        ? ["network", props.networking.networkId]
        : ["nics", ...props.networking.networkInterfaceIds],
    props.availabilityZone ?? null,
    props.affinityGroup ?? null,
    props.keypairName ?? null,
    props.userData ?? null,
    props.agent?.provisioned ?? null,
    props.agent?.vmMonitoring ?? null,
    props.configDrive ?? null,
  ]);

/** The network interfaces and volume a server's props take over exclusively. */
const exclusiveDevices = (props: ServerProps) => [
  ...(props.networking !== undefined && "networkInterfaceIds" in props.networking
    ? props.networking.networkInterfaceIds
    : []),
  ...(props.bootVolume?.source.type === "volume" ? [props.bootVolume.source.id] : []),
];

/**
 * An interface or volume attaches to one server at a time: a replacement
 * that keeps one can only take it once the old server has let go.
 */
const reusesExclusiveDevice = (news: ServerProps, olds: ServerProps) => {
  const previous = new Set(exclusiveDevices(olds));
  return exclusiveDevices(news).some((device) => previous.has(device));
};

export const ServerProvider = () =>
  Provider.succeed(Server, {
    stables: ["serverId", "projectId", "region"],
    nuke: {
      dependsOn: [
        "Stackit.IaaS.NetworkInterface",
        "Stackit.IaaS.Network",
        "Stackit.IaaS.SecurityGroup",
        "Stackit.IaaS.KeyPair",
        "Stackit.IaaS.Volume",
        "Stackit.IaaS.AffinityGroup",
      ],
    },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const { items } = yield* iaas.listServers({ ...scope, details: true });
      return ownedOnly(items).map((server) => toAttrs(server, scope, server.name ?? ""));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      if (
        hasUnresolvedTrigger<ServerProps>(news, [
          "projectId",
          "region",
          "imageId",
          "bootVolume",
          "networking",
          "availabilityZone",
          "affinityGroup",
          "keypairName",
          "userData",
          "agent",
          "configDrive",
        ])
      ) {
        return { action: "replace" } as const;
      }
      const resolved = triggerProps<ServerProps>(news);
      if (yield* projectScopeChanged(resolved, output)) return { action: "replace" } as const;
      if (olds !== undefined) {
        if (createOnlyKey(resolved) === createOnlyKey(olds)) return undefined;
        if (!reusesExclusiveDevice(resolved, olds)) return { action: "replace" } as const;
        // The old server goes first, before the schedules and backups of this stack: refuse
        // here, where nothing has happened yet. `olds` because the old server's delete sees them.
        if (olds.forceDestroy !== true) {
          const target = {
            projectId: output.projectId,
            region: output.region,
            serverId: output.serverId,
          };
          const objects = yield* listServerBackupObjects(target);
          if (objects.schedules.length > 0 || objects.backups.length > 0) {
            return yield* notEmptyError(
              target,
              objects,
              "This change deletes the old server first, so nothing was changed. Move them first, or deploy forceDestroy: true on the server on its own, then make this change.",
            );
          }
        }
        return { action: "replace", deleteFirst: true } as const;
      }
      // Adopted without previous props: compare what the server reports.
      if (resolved.imageId !== undefined && resolved.imageId !== output.imageId) {
        return { action: "replace" } as const;
      }
      if (resolved.keypairName !== undefined && resolved.keypairName !== output.keypairName) {
        return { action: "replace" } as const;
      }
      if (resolved.affinityGroup !== undefined && resolved.affinityGroup !== output.affinityGroup) {
        return { action: "replace" } as const;
      }
      if (
        resolved.availabilityZone !== undefined &&
        resolved.availabilityZone !== output.availabilityZone
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const name = output?.name ?? (yield* iaasName(id, olds?.name));
      const observed = yield* observe({
        id,
        name,
        scope,
        serverId: output?.serverId,
        news: olds,
        instanceId: readGeneration({ instanceId, output, previous }),
      });
      if (observed === undefined) return undefined;
      const attrs = toAttrs(observed, scope, name);
      return (yield* hasAlchemyLabels(id, observed.labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const name = yield* iaasName(id, news.name);
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);
      const resource = `STACKIT server ${name}`;

      // Observe — `output.serverId` is a cache; fall back to this generation's
      // labels + name for a create whose state was never persisted.
      let current = yield* observe({
        id,
        name,
        scope,
        serverId: output?.serverId,
        news,
        instanceId,
      });

      // Ensure — create when missing.
      let created = false;
      if (current === undefined) {
        current = yield* iaas.createServer({
          ...scope,
          name,
          machineType: news.machineType,
          imageId: news.imageId,
          bootVolume: toBootVolume(news.bootVolume),
          networking: toNetworking(news.networking),
          availabilityZone: news.availabilityZone,
          affinityGroup: news.affinityGroup,
          keypairName: news.keypairName,
          userData: news.userData === undefined ? undefined : Base64.encode(news.userData),
          agent: news.agent,
          configDrive: news.configDrive,
          metadata: news.metadata,
          labels,
        });
        created = true;
      }
      const serverId = current.id;
      if (serverId === undefined) {
        return yield* new ServerIdMissing({
          resourceName: name,
          message: `STACKIT returned server ${name} without an id`,
        });
      }
      const read = iaas.getServer({ ...scope, serverId, details: true });
      const settle = (until: (server: iaas.ServerOutput) => boolean) =>
        waitFor({
          resource,
          read,
          ready: (server) => isSettled(server) && until(server),
          failed: hasFailed,
          state: (server) => server.status,
          timeout: READY_TIMEOUT,
          maxInterval: "15 seconds",
        });

      // A new server is ready once it is ACTIVE; an existing one once it is
      // in any settled state.
      let observed = yield* settle((server) => !created || server.status === "ACTIVE");

      // Sync machine type — resize in place (the server restarts).
      if (observed.machineType !== news.machineType) {
        yield* iaas
          .resizeServer({ ...scope, serverId, machineType: news.machineType })
          .pipe(Effect.retry(conflictRetry));
        observed = yield* settle((server) => server.machineType === news.machineType);
      }

      // Sync name, labels and metadata in one update.
      const patch: Omit<iaas.UpdateServerRequest, "projectId" | "region" | "serverId"> = {};
      if (observed.name !== name) patch.name = name;
      const labelPatch = labelsPatch(observed.labels, labels);
      if (labelPatch !== undefined) patch.labels = labelPatch;
      if (
        news.metadata !== undefined &&
        !recordsEqual(metadataRecord(observed.metadata), news.metadata)
      ) {
        patch.metadata = news.metadata;
      }
      if (Object.keys(patch).length > 0) {
        yield* iaas.updateServer({ ...scope, serverId, ...patch });
      }

      // Sync power state.
      if (news.desiredStatus !== undefined) {
        const target = statusOf[news.desiredStatus];
        const status = yield* read.pipe(Effect.map((server) => server.status));
        if (status !== target) {
          if (news.desiredStatus === "active") {
            yield* iaas.startServer({ ...scope, serverId }).pipe(Effect.retry(conflictRetry));
          } else if (news.desiredStatus === "inactive") {
            yield* iaas.stopServer({ ...scope, serverId }).pipe(Effect.retry(conflictRetry));
          } else {
            yield* iaas.deallocateServer({ ...scope, serverId }).pipe(Effect.retry(conflictRetry));
          }
          yield* settle((server) => server.status === target);
        }
      }

      const final = yield* read;
      return toAttrs({ ...final, id: serverId }, scope, name);
    }),

    delete: Effect.fn(function* ({ olds, output, force }) {
      const scope = { projectId: output.projectId, region: output.region };
      const target = { ...scope, serverId: output.serverId };
      // The stack's own schedules and backups are deleted and awaited before this. What's left
      // can't be reached once the server is gone, so that takes an opt-in: the prop, or nuke.
      if (olds?.forceDestroy !== true && force !== true) {
        const left = yield* childrenLeftAfterSettling(
          listServerBackupObjects(target).pipe(
            Effect.map(({ schedules, backups }) => [
              ...schedules.map(({ name }) => ({ kind: "schedule" as const, name })),
              ...backups.map(({ name }) => ({ kind: "backup" as const, name })),
            ]),
          ),
        );
        if (left.length > 0) {
          return yield* notEmptyError(
            target,
            {
              schedules: left.filter((object) => object.kind === "schedule"),
              backups: left.filter((object) => object.kind === "backup"),
            },
            "The server was not deleted. Delete them first, or deploy forceDestroy: true on the server to allow this. A server already being replaced keeps the props it was deployed with, so only deleting them by hand finishes that replacement.",
          );
        }
      }
      yield* iaas
        .deleteServer({ ...scope, serverId: output.serverId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: `STACKIT server ${output.name}`,
        read: getServer(scope, output.serverId),
        state: (server) => server.status,
        timeout: "10 minutes",
        maxInterval: "15 seconds",
      });
    }),
  });
