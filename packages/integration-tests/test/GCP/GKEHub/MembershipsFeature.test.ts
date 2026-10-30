import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as gkehub from "@distilled.cloud/gcp/gkehub_v2";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { fleetMembership } from "./fixtures/fleet.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// The lifecycle registers its own GKE cluster with the fleet (about 10
// minutes to create), so `--fast` skips it.
const runLifecycle = !process.env.FAST;

const missingMembershipOf = (project: string) =>
  `projects/${project}/locations/global/memberships/alchemy-missing-membership`;
const missingFeatureOf = (project: string) =>
  `${missingMembershipOf(project)}/features/configmanagement`;

const waitUntilGone = (name: string) =>
  gkehub.getProjectsLocationsMembershipsFeatures({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsMembershipsFeatures on a missing feature fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const missingFeature = missingFeatureOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gkehub.getProjectsLocationsMembershipsFeatures({
          name: missingFeature,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* gkehub.listProjectsLocationsMembershipsFeatures({
        parent: `projects/${project}/locations/global/memberships/-`,
        pageSize: 10,
      });
      expect((page.membershipFeatures ?? []).map((feature) => feature.name)).not.toContain(
        missingFeature,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:gkehub", "live"], timeout: 90_000 },
);

test.provider(
  "create against a missing membership fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const missingMembership = missingMembershipOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.GKEHub.MembershipsFeature("ConfigSync", {
              membership: missingMembership,
              featureId: "configmanagement",
              spec: {
                configmanagement: {
                  configSync: { enabled: false },
                },
              },
              labels: { env: "test" },
            });
          }),
        ),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:gkehub", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a membership feature",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const membership = yield* fleetMembership({ env: "test" });
          return yield* GCP.GKEHub.MembershipsFeature("ConfigSync", {
            membership: membership.name,
            featureId: "configmanagement",
            spec: {
              configmanagement: {
                configSync: { enabled: false },
              },
            },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/features/");
      expect(created.featureId).toEqual("configmanagement");
      expect(created.membership).toContain("/memberships/");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* gkehub.getProjectsLocationsMembershipsFeatures({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          yield* fleetMembership({ env: "test" });
          return yield* GCP.GKEHub.MembershipsFeature("ConfigSync", {
            membership: created.membership,
            featureId: created.featureId,
            location: created.location,
            spec: {
              configmanagement: {
                configSync: { enabled: false, preventDrift: true },
              },
            },
            labels: { env: "prod", role: "hub" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "hub" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:gkehub", "live"], timeout: 2_700_000 },
);
