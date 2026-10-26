import * as eventhub from "@distilled.cloud/azure/eventhub";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
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
  /**
   * Hours to retain events, up to the namespace tier's maximum (Basic 24,
   * Standard 168, Premium and Dedicated 2160).
   * @default Azure's default for the tier
   */
  retentionTimeInHours?: number;
  /**
   * Minimum minutes an event stays ineligible for compaction (`Compact`
   * policies only).
   * @default Azure's default
   */
  minCompactionLagTimeInMinutes?: number;
  /**
   * Hours to retain tombstone markers of a compacted event hub (`Compact`
   * policies only).
   * @default Azure's default
   */
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
  /**
   * Capture time window in seconds (60-900): a file is written when this
   * window or the size window ends, whichever comes first.
   * @default Azure's default (`300`)
   */
  intervalInSeconds?: number;
  /**
   * Capture size window in bytes (10485760-524288000).
   * @default Azure's default (`314572800`, 300 MB)
   */
  sizeLimitInBytes?: number;
  /**
   * Skip writing archive files for windows with no events.
   * @default false
   */
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
    /**
     * Managed identity Capture writes with.
     * @default the namespace's own access to the storage account
     */
    identity?: {
      /** Identity type. */
      type: "SystemAssigned" | "UserAssigned";
      /** ARM ID of the user-assigned identity (for `UserAssigned`). */
      userAssignedIdentity?: string;
    };
  };
}

export interface EventHubProps {
  /**
   * Resource group of the namespace.
   *
   * :::caution
   * Changing it replaces the event hub.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the namespace that holds the event hub (`namespace.namespaceName`).
   *
   * :::caution
   * Changing it replaces the event hub.
   * :::
   */
  namespace: string;
  /**
   * Event hub name: 1-256 letters, digits, periods, hyphens, and
   * underscores, starting and ending with a letter or digit. If omitted, a
   * unique name is generated from the app, stage, and logical ID.
   *
   * :::caution
   * Changing it replaces the event hub.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Number of partitions (1-32 on Basic/Standard).
   *
   * :::caution
   * Premium and dedicated namespaces add partitions in place. Any other
   * change replaces the event hub.
   * :::
   * @default 4
   */
  partitionCount?: number;
  /**
   * Days to retain events (Basic: 1, Standard: 1-7). Superseded by
   * `retention`; set only one of them.
   * @default 1 (when `retention` is not set)
   */
  messageRetentionInDays?: number;
  /**
   * Retention settings.
   *
   * :::caution
   * Changing `cleanupPolicy` replaces the event hub.
   * :::
   * @default `messageRetentionInDays` applies
   */
  retention?: EventHubRetention;
  /**
   * Entity status, e.g. `SendDisabled` to stop producers.
   * @default "Active"
   */
  status?: EventHubStatus;
  /**
   * Capture events to Blob Storage (Standard and above, billed
   * separately). Removing it turns an enabled Capture off.
   * @default Capture off
   */
  capture?: EventHubCapture;
  /**
   * Timestamp events carry: broker append time (`LogAppend`) or producer
   * create time (`Create`).
   * @default Azure's default (`LogAppend`)
   */
  timestampType?: "LogAppend" | "Create";
  /**
   * Free-form user metadata. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`) because event hubs have no tags.
   * @default only the ownership marker
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
 * An Azure event hub (`Microsoft.EventHub/namespaces/eventhubs`): a
 * partitioned, append-only stream of events inside an Event Hubs namespace.
 * Producers append events; each consumer group reads the stream at its own
 * pace.
 *
 * Alchemy creates the event hub with four partitions and one day of
 * retention. Bind it to a runtime with `Send` to produce events (the binding
 * assigns **Azure Event Hubs Data Sender** on this event hub only), and read
 * it with `consumeEvents`. Event hubs have no tags, so Alchemy records
 * ownership as a `[alchemy <stack>/<stage>/<id>]` marker at the end of
 * `userMetadata`.
 *
 * :::caution[Changing `name`, `namespace`, `resourceGroup`, or `retention.cleanupPolicy` replaces the event hub]
 * Alchemy creates a new event hub and deletes the old one with every
 * retained event. Lowering `partitionCount`, or raising it on a `Basic` or
 * `Standard` namespace, replaces it too: only `Premium` and dedicated
 * namespaces add partitions in place.
 * :::
 *
 * @see https://learn.microsoft.com/azure/event-hubs/event-hubs-features
 *
 * ### Creating an Event Hub
 * **Example:** Event hub in a new namespace
 * ```typescript
 * const hubs = yield* Azure.EventHub.Namespace("hubs");
 * const readings = yield* Azure.EventHub.EventHub("readings", {
 *   namespace: hubs.namespaceName,
 * });
 * ```
 *
 * ### Partitions
 * Partitions set how many consumers read in parallel. Events with the same
 * partition key land in the same partition, in send order.
 *
 * **Example:** Two partitions
 * ```typescript
 * const readings = yield* Azure.EventHub.EventHub("readings", {
 *   namespace: hubs.namespaceName,
 *   partitionCount: 2,
 * });
 * ```
 *
 * ### Retention
 * **Example:** Keep events for seven days (Standard)
 * ```typescript
 * const readings = yield* Azure.EventHub.EventHub("readings", {
 *   namespace: hubs.namespaceName,
 *   messageRetentionInDays: 7,
 * });
 * ```
 *
 * **Example:** Keep events for 72 hours
 * ```typescript
 * const readings = yield* Azure.EventHub.EventHub("readings", {
 *   namespace: hubs.namespaceName,
 *   retention: { cleanupPolicy: "Delete", retentionTimeInHours: 72 },
 * });
 * ```
 *
 * **Example:** Keep the latest event per key (Premium)
 * ```typescript
 * const hubs = yield* Azure.EventHub.Namespace("hubs", { sku: "Premium" });
 * const devices = yield* Azure.EventHub.EventHub("device-state", {
 *   namespace: hubs.namespaceName,
 *   retention: { cleanupPolicy: "Compact", tombstoneRetentionTimeInHours: 24 },
 * });
 * ```
 *
 * ### Capture
 * Capture writes every event to Blob Storage as Avro files, per time or
 * size window (`Standard` and above, billed separately).
 *
 * **Example:** Archive events to a blob container every five minutes
 * ```typescript
 * const archive = yield* Azure.Storage.StorageAccount("archive");
 * const raw = yield* Azure.Storage.BlobContainer("raw", {
 *   storageAccount: archive.storageAccountName,
 * });
 * const readings = yield* Azure.EventHub.EventHub("readings", {
 *   namespace: hubs.namespaceName,
 *   capture: {
 *     enabled: true,
 *     intervalInSeconds: 300,
 *     skipEmptyArchives: true,
 *     destination: {
 *       storageAccountResourceId: archive.storageAccountId,
 *       blobContainer: raw.containerName,
 *       archiveNameFormat:
 *         "{Namespace}/{EventHub}/{PartitionId}/{Year}/{Month}/{Day}/{Hour}/{Minute}/{Second}",
 *     },
 *   },
 * });
 * ```
 *
 * ### Consumer Groups
 * Give each reading application its own consumer group (`Standard` and
 * above), so they keep separate positions in the stream.
 *
 * **Example:** A consumer group for analytics
 * ```typescript
 * const analytics = yield* Azure.EventHub.ConsumerGroup("analytics", {
 *   namespace: hubs.namespaceName,
 *   eventHub: readings.eventHubName,
 *   name: "analytics",
 * });
 * ```
 *
 * ### Pausing an Event Hub
 * **Example:** Stop accepting new events
 * ```typescript
 * const readings = yield* Azure.EventHub.EventHub("readings", {
 *   namespace: hubs.namespaceName,
 *   status: "SendDisabled",
 * });
 * ```
 *
 * ### Binding to a runtime
 * `Send` assigns **Azure Event Hubs Data Sender** on this event hub only.
 * It works on any host: a managed-identity host (an Azure Function, Web
 * App, Container App, container group, or VM) gets the role on its
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal. Event Hubs has no HTTP read API, so reading
 * goes through an event source.
 *
 * **Example:** Send events from an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const hub = yield* Readings;
 *     const readings = yield* Azure.EventHub.Send(hub);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* readings.send({ deviceId: "d1", temperature: 21 }, { partitionKey: "d1" });
 *         return HttpServerResponse.text("sent", { status: 202 });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventHub.SendHttp)),
 * ) {}
 * ```
 *
 * ### Runtime Operations
 * **Example:** Send one event, a batch, or to one partition
 * ```typescript
 * // init
 * const readings = yield* Azure.EventHub.Send(hub);
 *
 * // runtime
 * yield* readings.send({ deviceId, temperature }, { partitionKey: deviceId });
 * yield* readings.sendBatch(batch, { properties: { source: "gateway" } });
 * yield* readings.sendToPartition("0", { kind: "rebalance" });
 * yield* readings.sendAsPublisher(deviceId, { kind: "online" }); // Standard or higher
 * ```
 *
 * ### Event Sources
 * Run a handler for each batch of events. The host checkpoints after the
 * handler returns, whether it succeeded or failed: Event Hubs does not
 * deliver a failed batch again, so handle errors inside the handler.
 *
 * **Example:** Consume events in an Azure Function
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Azure.EventHub.consumeEvents(Readings, (batch) =>
 *       Effect.log(`${batch.events.length} readings`),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.Functions.EventHubEventSource)),
 * ) {}
 * ```
 *
 * **Example:** Read with your own consumer group
 * ```typescript
 * // the `analytics` consumer group from "Consumer Groups" above
 * yield* Azure.EventHub.consumeEvents(
 *   Readings,
 *   { consumerGroup: "analytics" },
 *   (batch) => Effect.log(batch.sequenceNumbers),
 * );
 * ```
 *
 * ### Deleting an Event Hub
 * Destroying the event hub deletes its retained events and consumer
 * groups.
 *
 * **Example:** Keep the event hub when the stack is destroyed
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const readings = yield* Azure.EventHub.EventHub("readings", {
 *   namespace: hubs.namespaceName,
 * }).pipe(RemovalPolicy.retain());
 * ```
 *
 * @resource
 */
export const EventHub = GroupedResource<EventHub>("Azure.EventHub.EventHub");

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
            storageAccountResourceId: capture.destination.storageAccountResourceId,
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
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.namespace.toLowerCase() !== output.namespace.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.eventHubName.toLowerCase()) ||
        (news.retention?.cleanupPolicy !== undefined &&
          news.retention.cleanupPolicy !== (output.cleanupPolicy ?? "Delete"))
      ) {
        return { action: "replace" } as const;
      }
      const partitions = news.partitionCount ?? 4;
      if (output.partitionCount !== undefined && partitions !== output.partitionCount) {
        // Partitions can only be added, and only on Premium and Dedicated.
        if (partitions < output.partitionCount) {
          return { action: "replace" } as const;
        }
        const { subscriptionId } = yield* AzureEnvironment.current;
        const parent = yield* getNamespace(subscriptionId, output.resourceGroup, output.namespace);
        const scalable =
          parent?.sku?.name === "Premium" || parent?.properties?.clusterArmId !== undefined;
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
      const name = output?.eventHubName ?? olds?.name ?? (yield* createEntityName(id, 256));
      const observed = yield* getEventHub(subscriptionId, resourceGroup, namespace, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespace, name, observed);
      const marker = yield* ownershipMarker(id);
      return (observed.properties?.userMetadata ?? "").endsWith(marker) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventHub");
      const { resourceGroup, namespace } = news;
      const name = news.name ?? output?.eventHubName ?? (yield* createEntityName(id, 256));
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
          news.messageRetentionInDays ?? (news.retention === undefined ? 1 : undefined),
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
        userMetadata: withMarker(news.userMetadata, yield* ownershipMarker(id)),
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

      const fresh = yield* waitForProvisioned(`event hub ${name}`, get, () => undefined, {
        interval: "2 seconds",
        times: 15,
      });
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
        getEventHub(subscriptionId, output.resourceGroup, output.namespace, output.eventHubName),
      );
    }),

    nuke: {
      dependsOn: ["Azure.EventHub.Namespace", "Azure.Resources.ResourceGroup"],
    },
  });
