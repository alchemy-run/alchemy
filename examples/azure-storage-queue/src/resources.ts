import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";

/** Holds the job queue and the results container. */
export const Data = Azure.Storage.StorageAccount("Data", { sku: "Standard_LRS" });

/**
 * The queue. The API enqueues one message per job; the worker's
 * `queueTrigger` function receives each one.
 */
export const Jobs = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.Queue("Jobs", { storageAccount: account.storageAccountName });
});

/**
 * Job results, one JSON blob per job at `jobs/{id}.json`. The worker writes
 * it when a job finishes; the API reads it to answer status polls.
 */
export const Results = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.BlobContainer("Results", {
    storageAccount: account.storageAccountName,
  });
});

/** What the API enqueues and the worker consumes. */
export interface JobMessage {
  id: string;
  payload: string;
  submittedAt: string;
}

/** The blob the worker writes at `jobs/{id}.json`. */
export interface JobResult {
  status: "done";
  /** Hex SHA-256 of the UTF-8 payload. */
  sha256: string;
  /** Whitespace-separated word count. */
  words: number;
  /** Payload length in characters. */
  chars: number;
  submittedAt: string;
  completedAt: string;
}

/** Blob name of a job's result. */
export const resultKey = (id: string) => `jobs/${id}.json`;
