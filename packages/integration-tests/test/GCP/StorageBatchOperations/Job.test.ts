import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sbo from "@distilled.cloud/gcp/storagebatchoperations_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Batch operations need Storage Intelligence, a paid project subscription
// the testing project doesn't have: create answers Forbidden "Storage
// Intelligence must be enabled for the bucket's project ... is not enrolled
// in Storage Intelligence." Set GCP_TEST_STORAGE_INTELLIGENCE=1 on a
// project that has it.
const intelligence = !!process.env.GCP_TEST_STORAGE_INTELLIGENCE;

const BatchOpsApi = GCP.ServiceUsage.ProjectService("StorageBatchOperationsApi", {
  service: "storagebatchoperations.googleapis.com",
});

const job = (cacheControl: string) =>
  Effect.gen(function* () {
    yield* BatchOpsApi;
    const bucket = yield* GCP.Storage.Bucket("Assets", {
      location: "US-CENTRAL1",
      forceDestroy: true,
    });
    return yield* GCP.StorageBatchOperations.Job("Retag", {
      description: "set cache control",
      bucket: { bucket: bucket.bucketName, includedObjectPrefixes: [""] },
      putMetadata: { cacheControl },
      dryRun: true,
    });
  });

const waitUntilGone = (name: string) =>
  sbo.getProjectsLocationsJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

test.provider(
  "getProjectsLocationsJobs on a missing job fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      yield* stack.deploy(BatchOpsApi);

      const error = yield* Effect.flip(
        sbo.getProjectsLocationsJobs({
          name: `projects/${project}/locations/global/jobs/alchemy-missing-job`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:storagebatchoperations", "live"], timeout: 90_000 },
);

test.provider.skipIf(intelligence)(
  "create is rejected without Storage Intelligence",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Without Storage Intelligence the API rejects the job: on a bucket it
      // can't act on yet with FAILED_PRECONDITION "User does not have required
      // permissions {storage.objects.update}", otherwise with "Storage
      // Intelligence must be enabled".
      const error = yield* Effect.flip(stack.deploy(job("no-store")));
      expect(JSON.stringify(error)).toMatch(
        /Storage Intelligence|does not have required permissions \{storage\.objects\.update\}/,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:storagebatchoperations", "live"], timeout: 300_000 },
);

test.provider.skipIf(!intelligence)(
  "run a batch job, replace it on a change, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(job("no-store"));
      expect(created.name).toContain("/locations/global/jobs/");

      const fetched = yield* sbo.getProjectsLocationsJobs({ name: created.name });
      expect(fetched.putMetadata?.cacheControl).toEqual("no-store");
      expect(fetched.dryRun).toEqual(true);

      const unchanged = yield* stack.plan(job("no-store"));
      expect(unchanged.resources.Retag?.action).toEqual("noop");

      // Jobs can't be edited: a new operation is a new job.
      const changed = yield* stack.plan(job("public, max-age=60"));
      expect(changed.resources.Retag?.action).toEqual("replace");

      const replaced = yield* stack.deploy(job("public, max-age=60"));
      expect(replaced.name).not.toEqual(created.name);
      expect(yield* waitUntilGone(created.name)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitUntilGone(replaced.name)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:storagebatchoperations", "live"], timeout: 600_000 },
);
