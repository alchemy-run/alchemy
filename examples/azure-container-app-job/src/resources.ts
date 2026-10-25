import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";

/**
 * When the report job runs: every minute (five fields, UTC), so a fresh
 * deploy shows a report quickly. Use `"0 2 * * *"` for a nightly report.
 */
export const SCHEDULE = "* * * * *";

/** Blob prefix of the files the API stores. */
export const FILES_PREFIX = "files/";

/** Blob the report job overwrites on every run. */
export const LATEST_REPORT = "reports/latest.json";

/** What the report job writes on every run. */
export interface Report {
  /** Name of the job execution that wrote the report. */
  execution: string;
  /** Number of blobs under `files/`. */
  files: number;
  /** Total size of those blobs, in bytes. */
  bytes: number;
  /** When the execution wrote the report (ISO 8601). */
  generatedAt: string;
}

/**
 * The Container Apps environment the job runs in. Jobs need a standard
 * environment (not `Express`); the Consumption profile has no idle cost.
 */
export const Env = Azure.ContainerApps.ManagedEnvironment("Env", {
  workloadProfiles: [{ name: "Consumption", workloadProfileType: "Consumption" }],
});

export const Data = Azure.Storage.StorageAccount("Data");

/** Holds the uploaded files (`files/…`) and the reports (`reports/…`). */
export const Bucket = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.BlobContainer("Bucket", {
    storageAccount: account.storageAccountName,
  });
});
