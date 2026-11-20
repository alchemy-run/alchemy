import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { expectFound } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const waitUntilGone = (project: string, zone: string, disk: string) =>
  compute.getDisks({ project, zone, disk }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a disk",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Disk("Data", {
            zone: "us-central1-a",
            type: "pd-standard",
            sizeGb: 10,
            labels: { env: "test" },
          });
        }),
      );
      yield* expectFound(
        GCP.Compute.Disk.lookup({ diskName: created.diskName, zone: created.zone }),
        created,
      );

      expect(created.diskName).toEqual(expect.any(String));
      expect(created.zone).toEqual("us-central1-a");
      expect(created.type).toEqual("pd-standard");
      expect(created.sizeGb).toEqual(10);
      expect(created.status).toEqual("READY");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* compute.getDisks({
        project: created.project,
        zone: created.zone,
        disk: created.diskName,
      });
      expect(fetched.name).toEqual(created.diskName);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.sizeGb).toEqual("10");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Disk("Data", {
            diskName: created.diskName,
            zone: "us-central1-a",
            type: "pd-standard",
            sizeGb: 11,
            labels: { env: "prod", role: "data" },
          });
        }),
      );

      expect(updated.diskName).toEqual(created.diskName);
      expect(updated.sizeGb).toEqual(11);
      expect(updated.labels).toMatchObject({ env: "prod", role: "data" });

      const fetchedUpdated = yield* compute.getDisks({
        project: updated.project,
        zone: updated.zone,
        disk: updated.diskName,
      });
      expect(fetchedUpdated.sizeGb).toEqual("11");
      expect(fetchedUpdated.labels?.env).toEqual("prod");
      expect(fetchedUpdated.labels?.role).toEqual("data");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.project, created.zone, created.diskName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider(
  "attach and detach a snapshot schedule on a disk",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (attached: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const schedule = yield* GCP.Compute.ResourcePolicy("Nightly", {
              region: "us-central1",
              snapshotSchedulePolicy: {
                schedule: { dailySchedule: { daysInCycle: 1, startTime: "04:00" } },
                retentionPolicy: { maxRetentionDays: 1 },
              },
            });
            const disk = yield* GCP.Compute.Disk("Scheduled", {
              zone: "us-central1-a",
              resourcePolicies: attached ? [schedule.resourcePolicyName] : [],
            });
            return { schedule, disk };
          }),
        );

      const created = yield* deploy(true);
      expect(created.disk.resourcePolicies).toHaveLength(1);
      expect(created.disk.resourcePolicies[0]).toContain(
        `/regions/us-central1/resourcePolicies/${created.schedule.resourcePolicyName}`,
      );

      const fetched = yield* compute.getDisks({
        project: created.disk.project,
        zone: created.disk.zone,
        disk: created.disk.diskName,
      });
      expect(fetched.resourcePolicies ?? []).toHaveLength(1);

      const detached = yield* deploy(false);
      expect(detached.disk.diskName).toEqual(created.disk.diskName);
      expect(detached.disk.resourcePolicies).toEqual([]);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.disk.project,
        created.disk.zone,
        created.disk.diskName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 180_000 },
);
