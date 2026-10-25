import { createHash } from "node:crypto";
import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { Jobs, resultKey, Results, type JobMessage, type JobResult } from "./resources.ts";

const isJob = (body: unknown): body is JobMessage =>
  typeof body === "object" &&
  body !== null &&
  typeof (body as JobMessage).id === "string" &&
  typeof (body as JobMessage).payload === "string";

/** The "work": hash and count the payload. */
const runJob = (job: JobMessage) =>
  Effect.sync((): JobResult => ({
    status: "done",
    sha256: createHash("sha256").update(job.payload, "utf8").digest("hex"),
    words: job.payload.split(/\s+/).filter(Boolean).length,
    chars: job.payload.length,
    submittedAt: job.submittedAt,
    completedAt: new Date().toISOString(),
  }));

/**
 * The consumer. `Azure.Storage.consumeQueueMessages` adds a native
 * `queueTrigger` function to the app, so the Functions host polls the queue
 * and runs the handler once per message. The app has no HTTP handler.
 *
 * The event source grants the app's managed identity **Storage Queue Data
 * Reader** and **Storage Queue Data Message Processor** on the queue. A
 * handler that fails makes the host retry the message; after five dequeues
 * it moves to `<queue>-poison`. Writing the result to a fixed blob name makes
 * processing idempotent: a redelivered job overwrites its blob with the same
 * values.
 */
export default class Worker extends Azure.Functions.Function<Worker>()(
  "Worker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const resultsContainer = yield* Results;
    const results = yield* Azure.Storage.BlobContainerWrite(resultsContainer);

    yield* Azure.Storage.consumeQueueMessages(Jobs, (message) =>
      Effect.gen(function* () {
        // A message that can never parse would be retried until it lands
        // in the poison queue; drop it now instead.
        if (!isJob(message.body)) {
          yield* Effect.logWarning(`dropping malformed message ${message.id}`);
          return;
        }
        const job = message.body;
        const result = yield* runJob(job);
        yield* results.put(resultKey(job.id), JSON.stringify(result), {
          contentType: "application/json",
        });
        yield* Effect.log(`job ${job.id}: ${result.words} word(s)`);
      }).pipe(
        // A failure fails the invocation, so the host retries the message.
        Effect.orDie,
      ),
    );
  }).pipe(
    Effect.provide([Azure.Storage.BlobContainerWriteHttp, Azure.Functions.StorageQueueEventSource]),
  ),
) {}
