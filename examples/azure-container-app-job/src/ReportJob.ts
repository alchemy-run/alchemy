import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { Bucket, Env, FILES_PREFIX, LATEST_REPORT, SCHEDULE, type Report } from "./resources.ts";

/**
 * The scheduled job. `Azure.ContainerApps.schedule` turns it into a
 * `Schedule` job on `SCHEDULE`, and each execution runs the handler once:
 * it sums the files under `files/` and writes the report to
 * `reports/<execution>.json` and `reports/latest.json`.
 *
 * Alchemy bundles this file for Node.js and builds its image in a Basic
 * container registry it creates for the job (no Docker needed). The job's
 * managed identity gets **AcrPull** on that registry and **Storage Blob
 * Data Contributor** on `Bucket`.
 */
export default class ReportJob extends Azure.ContainerApps.Job<ReportJob>()(
  "ReportJob",
  Effect.gen(function* () {
    const env = yield* Env;
    return {
      main: import.meta.url,
      environmentId: env.environmentId,
      cpu: 0.25,
      memory: "0.5Gi",
    };
  }),
  Effect.gen(function* () {
    const container = yield* Bucket;
    const bucket = yield* Azure.Storage.BlobContainerReadWrite(container);

    yield* Azure.ContainerApps.schedule(
      SCHEDULE,
      Effect.gen(function* () {
        // Container Apps names every execution `<job>-<suffix>`.
        const execution = yield* Effect.sync(
          () => process.env.CONTAINER_APP_JOB_EXECUTION_NAME ?? "local",
        );
        let files = 0;
        let bytes = 0;
        let marker: string | undefined;
        do {
          const page = yield* bucket.list({ prefix: FILES_PREFIX, marker });
          files += page.blobs.length;
          bytes += page.blobs.reduce((sum, blob) => sum + blob.size, 0);
          marker = page.nextMarker;
        } while (marker);
        const generatedAt = yield* Effect.sync(() => new Date().toISOString());
        const report: Report = { execution, files, bytes, generatedAt };
        const body = JSON.stringify(report);
        yield* bucket.put(`reports/${execution}.json`, body, { contentType: "application/json" });
        yield* bucket.put(LATEST_REPORT, body, { contentType: "application/json" });
        yield* Effect.log(`${execution}: ${files} file(s), ${bytes} byte(s)`);
      }).pipe(
        // A failed run fails its execution; the next one runs on schedule.
        Effect.orDie,
      ),
    );
  }).pipe(Effect.provide(Azure.Storage.BlobContainerReadWriteHttp)),
) {}
