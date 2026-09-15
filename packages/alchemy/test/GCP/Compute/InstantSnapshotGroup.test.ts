import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
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

const runLifecycle =
  hasGcpCreds &&
  !!process.env.GCP_TEST_INSTANT_SNAPSHOT_GROUP &&
  !process.env.FAST;

const zone = "us-central1-a";

const waitUntilGone = (
  project: string,
  zoneName: string,
  instantSnapshotGroup: string,
) =>
  compute
    .getInstantSnapshotGroups({
      project,
      zone: zoneName,
      instantSnapshotGroup,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "probe insertInstantSnapshotGroups entitlement",
  () =>
    Effect.gen(function* () {
      const project = process.env.GOOGLE_PROJECT_ID ?? "";
      const result = yield* compute
        .insertInstantSnapshotGroups({
          project,
          zone,
          sourceConsistencyGroup: "does-not-exist",
          body: {
            name: "alchemy-isg-probe",
            description: "alchemy entitlement probe",
            sourceConsistencyGroup: "does-not-exist",
          },
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", (error) =>
            Effect.succeed({
              tag: "Forbidden" as const,
              message: error.message,
            }),
          ),
          Effect.catchTag("BadRequest", (error) =>
            Effect.succeed({
              tag: "BadRequest" as const,
              message: error.message,
            }),
          ),
          Effect.catchTag("NotFound", (error) =>
            Effect.succeed({
              tag: "NotFound" as const,
              message: error.message,
            }),
          ),
        );
      if (result.tag === "ok") {
        yield* compute
          .deleteInstantSnapshotGroups({
            project,
            zone,
            instantSnapshotGroup: "alchemy-isg-probe",
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        return;
      }
      expect(["Forbidden", "BadRequest", "NotFound"]).toContain(result.tag);
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete an instant snapshot group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* GCP.Compute.ResourcePolicy("Consistent", {
            region: "us-central1",
            diskConsistencyGroupPolicy: {},
          });
          const disk = yield* GCP.Compute.Disk("Member", {
            zone,
            type: "hyperdisk-balanced",
            sizeGb: 4,
          });
          return { policy, disk };
        }),
      );

      yield* compute.addResourcePoliciesDisks({
        project: created.disk.project,
        zone,
        disk: created.disk.diskName,
        body: {
          resourcePolicies: [
            created.policy.selfLink ??
              `projects/${created.disk.project}/regions/us-central1/resourcePolicies/${created.policy.resourcePolicyName}`,
          ],
        },
      });

      const withGroup = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* GCP.Compute.ResourcePolicy("Consistent", {
            resourcePolicyName: created.policy.resourcePolicyName,
            region: "us-central1",
            diskConsistencyGroupPolicy: {},
          });
          const disk = yield* GCP.Compute.Disk("Member", {
            diskName: created.disk.diskName,
            zone,
            type: "hyperdisk-balanced",
            sizeGb: 4,
          });
          const group = yield* GCP.Compute.InstantSnapshotGroup("Checkpoint", {
            zone,
            sourceConsistencyGroup: policy.selfLink.as<string>(),
            description: "group checkpoint",
          });
          return { policy, disk, group };
        }),
      );

      expect(withGroup.group.instantSnapshotGroupName).toEqual(
        expect.any(String),
      );
      expect(withGroup.group.zone).toEqual(zone);
      expect(withGroup.group.description).toEqual("group checkpoint");

      const fetched = yield* compute.getInstantSnapshotGroups({
        project: withGroup.group.project,
        zone,
        instantSnapshotGroup: withGroup.group.instantSnapshotGroupName,
      });
      expect(fetched.name).toEqual(withGroup.group.instantSnapshotGroupName);
      expect(fetched.description).toContain("[alchemy ");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        withGroup.group.project,
        zone,
        withGroup.group.instantSnapshotGroupName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
