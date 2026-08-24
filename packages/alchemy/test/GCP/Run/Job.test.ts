import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const IMAGE = "us-docker.pkg.dev/cloudrun/container/job:latest";

const waitUntilGone = (name: string) =>
  cloudrun.getProjectsLocationsJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Run.Job("Migrate", {
            location: "us-central1",
            labels: { env: "test" },
            containers: [{ image: IMAGE }],
          });
        }),
      );

      expect(created.name).toContain("/jobs/");
      expect(created.jobId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.image).toEqual(IMAGE);

      const fetched = yield* cloudrun.getProjectsLocationsJobs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.template?.template?.containers?.[0]?.image).toEqual(IMAGE);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Run.Job("Migrate", {
            jobId: created.jobId,
            location: "us-central1",
            labels: { env: "prod", role: "migrate" },
            maxRetries: 1,
            timeout: "120s",
            containers: [
              {
                image: IMAGE,
                env: [{ name: "STAGE", value: "prod" }],
              },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "migrate" });
      expect(updated.maxRetries).toEqual(1);
      expect(updated.timeout).toEqual("120s");

      const refetched = yield* cloudrun.getProjectsLocationsJobs({
        name: created.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("migrate");
      expect(refetched.template?.template?.maxRetries).toEqual(1);
      expect(refetched.template?.template?.timeout).toEqual("120s");
      expect(refetched.template?.template?.containers?.[0]?.env).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "STAGE", value: "prod" }),
        ]),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
