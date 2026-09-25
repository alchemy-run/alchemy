import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as migrationcenter from "@distilled.cloud/gcp/migrationcenter_v1";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  migrationcenter.getProjectsLocationsGroups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsGroups on a missing group fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        migrationcenter.getProjectsLocationsGroups({
          name: `projects/${project}/locations/us-central1/groups/alchemy-missing-group`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a migration center group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Migrationcenter.Group("Workloads", {
            location: "us-central1",
            displayName: "workloads",
            description: "production vms",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.groupId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/locations/us-central1/groups/${created.groupId}`,
      );
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("workloads");
      expect(created.description).toEqual("production vms");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* migrationcenter.getProjectsLocationsGroups({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("workloads");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Migrationcenter.Group("Workloads", {
            groupId: created.groupId,
            location: "us-central1",
            displayName: "workloads-v2",
            description: "production vms v2",
            labels: { env: "prod", team: "migration" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("workloads-v2");
      expect(updated.description).toEqual("production vms v2");
      expect(updated.labels).toMatchObject({ env: "prod", team: "migration" });

      const fetchedUpdate = yield* migrationcenter.getProjectsLocationsGroups({
        name: updated.name,
      });
      expect(fetchedUpdate.displayName).toEqual("workloads-v2");
      expect(fetchedUpdate.labels?.team).toEqual("migration");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
