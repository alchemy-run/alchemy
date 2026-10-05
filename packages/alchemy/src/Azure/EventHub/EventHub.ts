import * as eventhub from "@distilled.cloud/azure/eventhub";
import * as Effect from "effect/Effect";
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
  createEntityName,
  getNamespace,
  matchesObserved,
  ownershipMarker,
  stripMarker,
  withMarker,
} from "./Common.ts";

export type EventHubStatus =
  | "Active"
  | "Disabled"
  | "Restoring"
  | "SendDisabled"
  | "ReceiveDisabled"
  | "Creating"
  | "Deleting"
  | "Renaming"
  | "Unknown";

export interface EventHubRetention {
  /**
   * `Delete` drops events after the retention time; `Compact` keeps the
   * latest event per key (Premium/Dedicated only).
   * @default "Delete"
   */
  cleanupPolicy?: "Delete" | "Compact" | "DeleteOrCompact";
  /** Hours to retain events, up to the namespace tier's maximum. */
  retentionTimeInHours?: number;
  /** Minimum minutes an event stays ineligible for compaction. */
  minCompactionLagTimeInMinutes?: number;
  /** Hours to retain tombstone markers of a compacted event hub. */
  tombstoneRetentionTimeInHours?: number;
}

export interface EventHubCapture {
  /** Whether Capture is enabled. */
  enabled: boolean;
  /**
   * Archive encoding.
   * @default "Avro"
   */
  encoding?: "Avro" | "AvroDeflate";
  /** Capture window in seconds (60-900). */
  intervalInSeconds?: number;
  /** Capture size window in bytes (10485760-524288000). */
  sizeLimitInBytes?: number;
  /** Skip writing empty archive files. */
  skipEmptyArchives?: boolean;
  /** Blob storage destination. */
  destination: {
    /**
     * Destination name.
     * @default "EventHubArchive.AzureBlockBlob"
     */
    name?: string;
    /** ARM ID of the storage account that receives the archives. */
    storageAccountResourceId: string;
    /** Blob container that receives the archives. */
    blobContainer: string;
    /**
     * Blob naming convention, e.g.
     * `{Namespace}/{EventHub}/{PartitionId}/{Year}/{Month}/{Day}/{Hour}/{Minute}/{Second}`.
     */
    archiveNameFormat: string;
    /** Managed identity Capture writes with. */
    identity?: {
      type: "SystemAssigned" | "UserAssigned";
      /** ARM ID of the user-assigned identity (for `UserAssigned`). */
      userAssignedIdentity?: string;
    };
  };
}

export interface EventHubProps {
  /** Resource group of the namespace. Changing it replaces the event hub. */
  resourceGroup: string;
  /** Namespace that holds the event hub. Changing it replaces the event hub. */
  namespace: string;
  /**
   * Event hub name: 1-256 letters, digits, periods, hyphens, and
   * underscores, starting and ending with a letter or digit. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the event hub.
   */
  name?: string;
  /**
   * Number of partitions (1-32 on Basic/Standard). Partitions can only be
   * added on Premium and Dedicated namespaces; any other change replaces the
   * event hub.
   * @default 4
   */
  partitionCount?: number;
  /**
   * Days to retain events (Basic: 1, Standard: 1-7). Superseded by
   * `retention`; set only one of them.
   * @default 1 (when `retention` is not set)
   */
  messageRetentionInDays?: number;
  /** Retention settings. Changing `cleanupPolicy` replaces the event hub. */
  retention?: EventHubRetention;
  /**
   * Entity status, e.g. `SendDisabled` to stop producers.
   * @default "Active"
   */
  status?: EventHubStatus;
  /** Capture events to Blob Storage (Standard and above, billed separately). */
  capture?: EventHubCapture;
  /** Timestamp events carry: broker append time or producer create time. */
  timestampType?: "LogAppend" | "Create";
  /**
   * Free-form user metadata. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`) because event hubs have no tags.
   */
  userMetadata?: string;
}

export interface EventHub extends Resource<
  "Azure.EventHub.EventHub",
  EventHubProps,
  {
    /** Name of the event hub. */
    eventHubName: string;
    /** ARM resource ID of the event hub; use it as a role-assignment scope. */
    eventHubId: string;
    /** Namespace that holds the event hub. */
    namespace: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Number of partitions. */
    partitionCount: number | undefined;
    /** Partition IDs. */
    partitionIds: string[];
    /** Entity status. */
    status: string | undefined;
    /** Retention cleanup policy (`Delete`, `Compact`, `DeleteOrCompact`). */
    cleanupPolicy: string | undefined;
    /** User metadata (Alchemy ownership marker stripped). */
    userMetadata: string | undefined;
    /** Time the event hub was created. */
    createdAt: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An event hub — a partitioned, append-only event stream inside an Event
 * Hubs namespace.
 *
 * Event hubs cannot be tagged, so Alchemy records ownership as a
 * `[alchemy <stack>/<stage>/<id>]` marker at the end of `userMetadata`.
 *
 * @see https://learn.microsoft.com/azure/event-hubs/event-hubs-features
 *
 * ### Creating an Event Hub
 * **Example:** Event hub with four partitions
 * ```typescript
 * const namespace = yield* Azure.EventHub.Namespace("events", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const orders = yield* Azure.EventHub.EventHub("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   partitionCount: 4,
 *   messageRetentionInDays: 1,
 * });
 * ```
 *
 * ### Retention
 * **Example:** Keep events for three days
 * ```typescript
 * const orders = yield* Azure.EventHub.EventHub("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   retention: { cleanupPolicy: "Delete", retentionTimeInHours: 72 },
 * });
 * ```
 *
 * ### Capture
 * **Example:** Archive events to Blob Storage
 * ```typescript
 * const orders = yield* Azure.EventHub.EventHub("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   capture: {
 *     enabled: true,
 *     intervalInSeconds: 300,
 *     destination: {
 *       storageAccountResourceId: account.storageAccountId,
 *       blobContainer: container.containerName,
 *       archiveNameFormat:
 *         "{Namespace}/{EventHub}/{PartitionId}/{Year}/{Month}/{Day}/{Hour}/{Minute}/{Second}",
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const EventHub = Resource<EventHub>("Azure.EventHub.EventHub");

const getEventHub = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  eventHubName: string,
) =>
  orUndefinedIfNotFound(
    eventhub.GetEventHub({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      eventHubName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  namespace: string,
  name: string,
  hub: eventhub.GetEventHubResponse,
): EventHub["Attributes"] => ({
  eventHubName: name,
  eventHubId: hub.id ?? "",
  namespace,
  resourceGroup,
  partitionCount: hub.properties?.partitionCount,
  partitionIds: [...(hub.properties?.partitionIds ?? [])],
  status: hub.properties?.status,
  cleanupPolicy: hub.properties?.retentionDescription?.cleanupPolicy,
  userMetadata: stripMarker(hub.properties?.userMetadata),
  createdAt: hub.properties?.createdAt,
});

const toCapture = (
  capture: EventHubCapture | undefined,
): eventhub.CaptureDescription | undefined =>
  capture === undefined
    ? undefined
    : {
        enabled: capture.enabled,
        encoding: capture.encoding ?? "Avro",
        intervalInSeconds: capture.intervalInSeconds,
        sizeLimitInBytes: capture.sizeLimitInBytes,
        skipEmptyArchives: capture.skipEmptyArchives,
        destination: {
          name: capture.destination.name ?? "EventHubArchive.AzureBlockBlob",
          identity: capture.destination.identity,
          properties: {
            storageAccountResourceId:
              capture.destination.storageAccountResourceId,
            blobContainer: capture.destination.blobContainer,
            archiveNameFormat: capture.destination.archiveNameFormat,
          },
        },
      };

export const EventHubProvider = () =>
  Provider.succeed(EventHub, {
    stables: ["eventHubName", "eventHubId", "namespace", "resourceGroup"],

    // Event hubs live inside a namespace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.namespace.toLowerCase() !== output.namespace.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.eventHubName.toLowerCase()) ||
        (news.retention?.cleanupPolicy !== undefined &&
          news.retention.cleanupPolicy !== (output.cleanupPolicy ?? "Delete"))
      ) {
        return { action: "replace" } as const;
      }
      const partitions = news.partitionCount ?? 4;
      if (
        output.partitionCount !== undefined &&
        partitions !== output.partitionCount
      ) {
        // Partitions can only be added, and only on Premium and Dedicated.
        if (partitions < output.partitionCount) {
          return { action: "replace" } as const;
        }
        const { subscriptionId } = yield* AzureEnvironment.current;
        const parent = yield* getNamespace(
          subscriptionId,
          output.resourceGroup,
          output.namespace,
        );
        const scalable =
          parent?.sku?.name === "Premium" ||
          parent?.properties?.clusterArmId !== undefined;
        if (!scalable) return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const namespace = output?.namespace ?? olds?.namespace;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its namespace.
      if (resourceGroup === undefined || namespace === undefined) {
        return undefined;
      }
      const name =
        output?.eventHubName ?? olds?.name ?? (yield* createEntityName(id, 256));
      const observed = yield* getEventHub(
        subscriptionId,
        resourceGroup,
        namespace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespace, name, observed);
      const marker = yield* ownershipMarker(id);
      return (observed.properties?.userMetadata ?? "").endsWith(marker)
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventHub");
      const { resourceGroup, namespace } = news;
      const name =
        news.name ?? output?.eventHubName ?? (yield* createEntityName(id, 256));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        namespaceName: namespace,
        eventHubName: name,
      };
      const get = getEventHub(subscriptionId, resourceGroup, namespace, name);

      // Observe.
      const observed = yield* get;
      const current = observed?.properties;

      const desired: eventhub.EventhubPropertiesInput = {
        partitionCount: news.partitionCount ?? 4,
        // Azure defaults to 7 days, which a Basic namespace rejects.
        messageRetentionInDays:
          news.messageRetentionInDays ??
          (news.retention === undefined ? 1 : undefined),
        retentionDescription: news.retention,
        status: news.status ?? "Active",
        // Removing `capture` turns an enabled Capture off.
        captureDescription:
          toCapture(news.capture) ??
          (current?.captureDescription?.enabled
            ? { ...current.captureDescription, enabled: false }
            : undefined),
        messageTimestampDescription: news.timestampType
          ? { timestampType: news.timestampType }
          : undefined,
        userMetadata: withMarker(
          news.userMetadata,
          yield* ownershipMarker(id),
        ),
      };

      // Ensure. New event hubs must start `Active`; the status sync below
      // applies any other status.
      if (current === undefined && desired.status !== "Active") {
        yield* eventhub.EventHubsCreateOrUpdate({
          ...where,
          properties: { ...desired, status: "Active" },
        });
      }

      // Sync. The PUT is a synchronous upsert; skip it when every desired
      // value already matches the observed event hub.
      const synced = current ?? (yield* get)?.properties;
      if (synced === undefined || !matchesObserved(desired, synced)) {
        yield* eventhub.EventHubsCreateOrUpdate({
          ...where,
          properties: desired,
        });
      }

      const fresh = yield* waitForProvisioned(
        `event hub ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, namespace, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventhub.DeleteEventHub({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespace,
          eventHubName: output.eventHubName,
        }),
      );
      yield* waitUntilGone(
        `event hub ${output.eventHubName}`,
        getEventHub(
          subscriptionId,
          output.resourceGroup,
          output.namespace,
          output.eventHubName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.EventHub.Namespace", "Azure.Resources.ResourceGroup"],
    },
  });
