import * as kr from "@distilled.cloud/azure/kubernetesruntime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  RUNTIME_WAIT,
  runtimeObjectName,
  runtimeState,
  sameId,
  sameList,
} from "./Common.ts";

/** Native storage class of the cluster (no backing configuration). */
export interface NativeStorageClassType {
  type: "Native";
}

/** ReadWriteMany storage layered on another storage class. */
export interface RwxStorageClassType {
  type: "RWX";
  /** Kubernetes storage class backing the new RWX class. */
  backingStorageClassName: string;
}

/** Azure Blob storage via the blob CSI driver. */
export interface BlobStorageClassType {
  type: "Blob";
  /** Azure Storage account name. */
  azureStorageAccountName: string;
  /** Azure Storage account key. Never read back from Azure. */
  azureStorageAccountKey: Redacted.Redacted<string>;
}

/** An NFS share. */
export interface NfsStorageClassType {
  type: "NFS";
  /** NFS server address. */
  server: string;
  /** NFS share path. */
  share: string;
  /** Sub directory under the share; created by the driver if missing. */
  subDir?: string;
  /**
   * Mounted folder permissions (e.g. `"0777"`). Non-zero makes the driver
   * `chmod` after mount.
   * @default "0"
   */
  mountPermissions?: string;
  /**
   * What to do with the volume's directory when it is deleted.
   * @default "Delete"
   */
  onDelete?: kr.NfsDirectoryActionOnVolumeDeletion;
}

/** An SMB share. */
export interface SmbStorageClassType {
  type: "SMB";
  /** SMB source, e.g. `//server/share`. */
  source: string;
  /** Sub directory under the share; created by the driver if missing. */
  subDir?: string;
  /** Server username. */
  username?: string;
  /** Server password. Never read back from Azure. */
  password?: Redacted.Redacted<string>;
  /** Server domain. */
  domain?: string;
}

/** Backing storage of a storage class, discriminated on `type`. */
export type StorageClassType =
  | NativeStorageClassType
  | RwxStorageClassType
  | BlobStorageClassType
  | NfsStorageClassType
  | SmbStorageClassType;

export interface StorageClassProps {
  /**
   * ARM resource ID of the Azure Arc-enabled Kubernetes cluster
   * (`Microsoft.Kubernetes/connectedClusters`). The cluster needs the
   * `storageclass` `Azure.KubernetesRuntime.Service`. Changing it replaces
   * the storage class.
   */
  clusterId: string;
  /**
   * Name of the storage class (3-24 letters, digits and `-`). If omitted,
   * a unique lowercase name is generated. Changing it replaces the storage
   * class.
   */
  name?: string;
  /**
   * Backing storage. Changing `type` replaces the storage class; the other
   * fields are updated in place.
   */
  typeProperties: StorageClassType;
  /** CSI provisioner name. Changing it replaces the storage class. */
  provisioner?: string;
  /**
   * When volumes are bound: `Immediate` or `WaitForFirstConsumer`.
   * Changing it replaces the storage class.
   */
  volumeBindingMode?: kr.VolumeBindingMode;
  /** Whether volumes can be expanded: `Allow` or `Disallow`. */
  allowVolumeExpansion?: kr.VolumeExpansion;
  /** Additional mount options. */
  mountOptions?: string[];
  /** Supported access modes (`ReadWriteOnce`, `ReadWriteMany`). */
  accessModes?: kr.AccessMode[];
  /** Whether the class survives a single data node failure. */
  dataResilience?: kr.DataResilienceTier;
  /** Failover speed: `NotAvailable`, `Slow`, `Fast` or `Super`. */
  failoverSpeed?: kr.FailoverTier;
  /** Free-form limitations of the class. */
  limitations?: string[];
  /** Performance tier: `Basic`, `Standard`, `Premium`, `Ultra`. */
  performance?: kr.PerformanceTier;
  /**
   * Selection priority when several classes match; `0` is highest, `-1`
   * means never select automatically.
   */
  priority?: number;
}

export interface StorageClass extends Resource<
  "Azure.KubernetesRuntime.StorageClass",
  StorageClassProps,
  {
    /** ARM resource ID of the storage class. */
    storageClassId: string;
    /** Name of the storage class. */
    storageClassName: string;
    /** ARM resource ID of the connected cluster. */
    clusterId: string;
    /** Observed storage class type. */
    type: string;
    /** Observed CSI provisioner. */
    provisioner: string | undefined;
    /** Observed volume binding mode. */
    volumeBindingMode: string | undefined;
    /** Observed volume expansion setting. */
    allowVolumeExpansion: string | undefined;
    /** Observed performance tier. */
    performance: string | undefined;
    /** Observed selection priority. */
    priority: number | undefined;
    /** Observed provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Kubernetes storage class on an Azure Arc-enabled Kubernetes cluster,
 * managed through ARM: native, ReadWriteMany layered on another class,
 * Azure Blob, NFS or SMB.
 *
 * Requires a connected cluster with the `storageclass` service enabled;
 * ARM proxies every write to the cluster. Storage classes carry no tags,
 * so one found at the expected scope is only treated as owned when Alchemy
 * created it.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/kubernetes/
 *
 * ### Storage Classes
 * **Example:** NFS storage class
 * ```typescript
 * const storage = yield* Azure.KubernetesRuntime.Service("storage", {
 *   clusterId,
 *   serviceName: "storageclass",
 * });
 * yield* Azure.KubernetesRuntime.StorageClass("nfs", {
 *   clusterId: storage.clusterId,
 *   typeProperties: {
 *     type: "NFS",
 *     server: "10.0.0.4",
 *     share: "/exports/data",
 *     onDelete: "Retain",
 *   },
 *   accessModes: ["ReadWriteOnce", "ReadWriteMany"],
 *   allowVolumeExpansion: "Allow",
 * });
 * ```
 *
 * **Example:** Blob storage class
 * ```typescript
 * yield* Azure.KubernetesRuntime.StorageClass("blob", {
 *   clusterId: storage.clusterId,
 *   typeProperties: {
 *     type: "Blob",
 *     azureStorageAccountName: account.storageAccountName,
 *     azureStorageAccountKey: Redacted.make(key),
 *   },
 * });
 * ```
 *
 * @resource
 */
export const StorageClass = Resource<StorageClass>(
  "Azure.KubernetesRuntime.StorageClass",
);

const getStorageClass = (resourceUri: string, storageClassName: string) =>
  orUndefinedIfNotFound(kr.GetStorageClass({ resourceUri, storageClassName }));

const toAttrs = (
  clusterId: string,
  storageClassName: string,
  observed: kr.GetStorageClassResponse,
): StorageClass["Attributes"] => ({
  storageClassId: observed.id ?? "",
  storageClassName,
  clusterId,
  type: observed.properties?.typeProperties.type ?? "",
  provisioner: observed.properties?.provisioner,
  volumeBindingMode: observed.properties?.volumeBindingMode,
  allowVolumeExpansion: observed.properties?.allowVolumeExpansion,
  performance: observed.properties?.performance,
  priority: observed.properties?.priority,
  provisioningState: observed.properties?.provisioningState,
});

const secret = (value: Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.value(value);

/** The PUT/PATCH wire shape of the type properties. */
const typeBody = (t: StorageClassType): kr.StorageClassTypeProperties => {
  switch (t.type) {
    case "Native":
      return { type: "Native" };
    case "RWX":
      return {
        type: "RWX",
        backingStorageClassName: t.backingStorageClassName,
      };
    case "Blob":
      return {
        type: "Blob",
        azureStorageAccountName: t.azureStorageAccountName,
        azureStorageAccountKey: t.azureStorageAccountKey,
      };
    case "NFS":
      return {
        type: "NFS",
        server: t.server,
        share: t.share,
        subDir: t.subDir,
        mountPermissions: t.mountPermissions,
        onDelete: t.onDelete,
      };
    case "SMB":
      return {
        type: "SMB",
        source: t.source,
        subDir: t.subDir,
        username: t.username,
        password: t.password,
        domain: t.domain,
      };
  }
};

const SECRET_FIELDS = ["azureStorageAccountKey", "password"] as const;

/**
 * Per-type fields to PATCH: observable fields that differ from the cloud,
 * plus secrets (never returned) when they differ from the last deploy.
 */
const typeDelta = (
  desired: StorageClassType,
  observed: kr.StorageClassTypeProperties | undefined,
  baseline: StorageClassType | undefined,
): kr.StorageClassTypePropertiesUpdate | undefined => {
  const seen: Record<string, any> = Object.fromEntries(
    Object.entries(observed ?? {}),
  );
  const last: Record<string, any> =
    baseline !== undefined && baseline.type === desired.type
      ? Object.fromEntries(Object.entries(baseline))
      : {};
  const delta: Record<string, any> = {};
  for (const [key, value] of Object.entries(typeBody(desired))) {
    if (key === "type" || value === undefined) continue;
    const changed = (SECRET_FIELDS as readonly string[]).includes(key)
      ? secret(last[key]) !== secret(value)
      : seen[key] !== value;
    if (changed) delta[key] = value;
  }
  return Object.keys(delta).length > 0 ? delta : undefined;
};

export const StorageClassProvider = () =>
  Provider.succeed(StorageClass, {
    stables: ["storageClassId", "storageClassName", "clusterId"],

    // Extension resources vanish with the cluster they extend.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.clusterId, output.clusterId) ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.storageClassName.toLowerCase()) ||
        news.typeProperties.type !== output.type ||
        (news.provisioner !== undefined &&
          news.provisioner !== output.provisioner) ||
        (news.volumeBindingMode !== undefined &&
          news.volumeBindingMode !== output.volumeBindingMode)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const clusterId = output?.clusterId ?? olds?.clusterId;
      if (clusterId === undefined) return undefined;
      const name =
        output?.storageClassName ??
        olds?.name ??
        (yield* runtimeObjectName(id));
      const observed = yield* getStorageClass(clusterId, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(clusterId, name, observed);
      // No tags or markers: only a storage class we persisted is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.KubernetesRuntime");
      const { clusterId } = news;
      const name =
        output?.storageClassName ?? news.name ?? (yield* runtimeObjectName(id));
      const get = getStorageClass(clusterId, name);
      const label = `kubernetes runtime storage class ${clusterId}/${name}`;

      // Observe.
      let observed = yield* get;
      // Secrets are never read back; the last deployed value is the baseline.
      let secretBaseline = olds?.typeProperties;

      // Ensure: PUT the full class when missing.
      if (observed === undefined) {
        yield* kr.StorageClassCreateOrUpdate({
          resourceUri: clusterId,
          storageClassName: name,
          properties: {
            typeProperties: typeBody(news.typeProperties),
            provisioner: news.provisioner,
            volumeBindingMode: news.volumeBindingMode,
            allowVolumeExpansion: news.allowVolumeExpansion,
            mountOptions: news.mountOptions,
            accessModes: news.accessModes,
            dataResilience: news.dataResilience,
            failoverSpeed: news.failoverSpeed,
            limitations: news.limitations,
            performance: news.performance,
            priority: news.priority,
          },
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          runtimeState,
          RUNTIME_WAIT,
        );
        secretBaseline = news.typeProperties;
      }

      // Sync: PATCH only the mutable fields that differ from observed.
      const props = observed.properties;
      const patch: kr.StorageClassPropertiesUpdate = {};
      if (
        news.allowVolumeExpansion !== undefined &&
        news.allowVolumeExpansion !== props?.allowVolumeExpansion
      ) {
        patch.allowVolumeExpansion = news.allowVolumeExpansion;
      }
      if (
        news.mountOptions !== undefined &&
        !sameList(news.mountOptions, props?.mountOptions)
      ) {
        patch.mountOptions = news.mountOptions;
      }
      if (
        news.accessModes !== undefined &&
        !sameList(news.accessModes, props?.accessModes)
      ) {
        patch.accessModes = news.accessModes;
      }
      if (
        news.dataResilience !== undefined &&
        news.dataResilience !== props?.dataResilience
      ) {
        patch.dataResilience = news.dataResilience;
      }
      if (
        news.failoverSpeed !== undefined &&
        news.failoverSpeed !== props?.failoverSpeed
      ) {
        patch.failoverSpeed = news.failoverSpeed;
      }
      if (
        news.limitations !== undefined &&
        !sameList(news.limitations, props?.limitations)
      ) {
        patch.limitations = news.limitations;
      }
      if (
        news.performance !== undefined &&
        news.performance !== props?.performance
      ) {
        patch.performance = news.performance;
      }
      if (news.priority !== undefined && news.priority !== props?.priority) {
        patch.priority = news.priority;
      }
      const typePatch = typeDelta(
        news.typeProperties,
        props?.typeProperties,
        secretBaseline,
      );
      if (typePatch !== undefined) patch.typeProperties = typePatch;

      if (Object.keys(patch).length > 0) {
        yield* kr.UpdateStorageClass({
          resourceUri: clusterId,
          storageClassName: name,
          properties: patch,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          runtimeState,
          RUNTIME_WAIT,
        );
      }

      return toAttrs(clusterId, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        kr.DeleteStorageClass({
          resourceUri: output.clusterId,
          storageClassName: output.storageClassName,
        }),
      );
      yield* waitUntilGone(
        `kubernetes runtime storage class ${output.clusterId}/${output.storageClassName}`,
        getStorageClass(output.clusterId, output.storageClassName),
        RUNTIME_WAIT,
      );
    }),
  });
