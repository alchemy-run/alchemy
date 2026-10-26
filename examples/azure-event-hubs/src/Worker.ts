import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schedule from "effect/Schedule";
import {
  Readings,
  Results,
  resultKey,
  type ReadingEvent,
  type ReadingResult,
} from "./resources.ts";

/** Decode one event body: the trigger hands JSON bodies over parsed or as text. */
const decode = (body: unknown): ReadingEvent | undefined => {
  let value = body;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== "object") return undefined;
  const { id, deviceId, temperature } = value as Record<string, unknown>;
  return typeof id === "string" && typeof deviceId === "string" && typeof temperature === "number"
    ? { id, deviceId, temperature }
    : undefined;
};

/** Read a trigger-metadata member whatever casing the host used. */
const member = (value: unknown, name: string): unknown => {
  if (value === null || typeof value !== "object") return undefined;
  const key = Object.keys(value).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : (value as Record<string, unknown>)[key];
};

/**
 * The consumer. `consumeEvents` becomes a native `eventHubTrigger` function
 * in this app, connected through the app's managed identity and reading
 * the `$Default` consumer group in batches, one partition at a time.
 *
 * The trigger checkpoints each partition in the app's own storage account
 * after the handler returns, whether it succeeded or failed: Event Hubs does
 * not redeliver a failed batch. So the handler retries its own writes and
 * logs a reading it could not record. Results are written with `put`, so a
 * reading delivered twice (after a host restart, before the checkpoint)
 * overwrites its blob with the same values.
 */
export default class Worker extends Azure.Functions.Function<Worker>()(
  "Worker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const resultsContainer = yield* Results;
    const results = yield* Azure.Storage.BlobContainerWrite(resultsContainer);

    yield* Azure.EventHub.consumeEvents(Readings, (batch) => {
      const partitionId = member(member(batch.metadata, "PartitionContext"), "PartitionId");
      return Effect.forEach(batch.events, (body, i) => {
        const reading = decode(body);
        if (reading === undefined) {
          return Effect.logWarning("skipping an event that is not a reading", body);
        }
        return Effect.sync((): ReadingResult => ({
          ...reading,
          partitionId: typeof partitionId === "string" ? partitionId : null,
          sequenceNumber: batch.sequenceNumbers[i] ?? null,
          enqueuedTimeUtc: batch.enqueuedTimesUtc[i] ?? null,
          batchSize: batch.events.length,
          processedAt: new Date().toISOString(),
        })).pipe(
          Effect.flatMap((result) =>
            results.put(resultKey(reading.id), JSON.stringify(result), {
              contentType: "application/json",
            }),
          ),
          // The app's Storage role can take a few minutes to propagate
          // after the first deploy (Azure documents up to 10).
          Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 30 }),
          Effect.catch((error) => Effect.logError(`could not record reading ${reading.id}`, error)),
        );
      }).pipe(Effect.asVoid);
    });

    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }).pipe(
    Effect.provide([Azure.Functions.EventHubEventSource, Azure.Storage.BlobContainerWriteHttp]),
  ),
) {}
