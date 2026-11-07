import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as batch from "@distilled.cloud/gcp/batch_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const location = "us-central1";

const BatchApi = GCP.ServiceUsage.ProjectService("BatchApi", {
  service: "batch.googleapis.com",
});

const job = (text: string) =>
  Effect.gen(function* () {
    yield* BatchApi;
    return yield* GCP.Batch.Job("Hello", {
      location,
      taskGroups: [
        {
          taskSpec: {
            runnables: [{ script: { text } }],
            computeResource: { cpuMilli: "500", memoryMib: "256" },
            maxRunDuration: "300s",
          },
        },
      ],
      allocationPolicy: { instances: [{ policy: { machineType: "e2-small" } }] },
      logsPolicy: { destination: "CLOUD_LOGGING" },
      labels: { env: "test" },
    });
  });

const waitUntilGone = (name: string) =>
  batch.getProjectsLocationsJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

test.provider(
  "getProjectsLocationsJobs on a missing job fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      yield* stack.deploy(BatchApi);

      const error = yield* Effect.flip(
        batch.getProjectsLocationsJobs({
          name: `projects/${project}/locations/${location}/jobs/alchemy-missing-job`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:batch", "live"], timeout: 90_000 },
);

test.provider(
  "run a job, replace it on a change, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(job("echo hello"));
      expect(created.name).toContain("/jobs/");
      expect(created.location).toEqual(location);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* batch.getProjectsLocationsJobs({ name: created.name });
      expect(fetched.taskGroups?.[0]?.taskSpec?.runnables?.[0]?.script?.text).toEqual("echo hello");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const unchanged = yield* stack.plan(job("echo hello"));
      expect(unchanged.resources.Hello?.action).toEqual("noop");

      // Batch jobs can't be edited: a new script is a new job.
      const changed = yield* stack.plan(job("echo goodbye"));
      expect(changed.resources.Hello?.action).toEqual("replace");

      const replaced = yield* stack.deploy(job("echo goodbye"));
      expect(replaced.uid).not.toEqual(created.uid);
      const oldGone = yield* waitUntilGone(created.name);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:batch", "live"], timeout: 900_000 },
);
