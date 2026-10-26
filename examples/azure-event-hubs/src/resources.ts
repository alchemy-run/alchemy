import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";

/**
 * The Event Hubs namespace. Standard, one throughput unit: Basic would also
 * work for this example (it only uses the `$Default` consumer group), but
 * Standard adds consumer groups and longer retention.
 */
export const Hubs = Azure.EventHub.Namespace("Hubs", { sku: "Standard" });

/**
 * The telemetry stream. Two partitions, so the partition key's routing is
 * visible: every reading of one device lands in the same partition, in
 * send order.
 */
export const Readings = Effect.gen(function* () {
  const hubs = yield* Hubs;
  return yield* Azure.EventHub.EventHub("Readings", {
    namespace: hubs.namespaceName,
    partitionCount: 2,
    messageRetentionInDays: 1,
  });
});

/** Storage for the consumer's results. */
export const Data = Azure.Storage.StorageAccount("Data");

/** One blob per consumed reading, at `readings/{id}`. The worker writes them; the API reads them. */
export const Results = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.BlobContainer("Results", {
    storageAccount: account.storageAccountName,
  });
});

/** What the API sends to the `Readings` event hub. */
export interface ReadingEvent {
  id: string;
  deviceId: string;
  temperature: number;
}

/** What the worker records for each reading it consumed. */
export interface ReadingResult extends ReadingEvent {
  /** Partition the reading was read from. */
  partitionId: string | null;
  /** The reading's sequence number in its partition. */
  sequenceNumber: number | null;
  /** When Event Hubs accepted the reading. */
  enqueuedTimeUtc: string | null;
  /** Number of events in the batch the trigger delivered. */
  batchSize: number;
  processedAt: string;
}

/** Blob name of a reading's result. */
export const resultKey = (id: string) => `readings/${id}`;
