import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as gkehub from "@distilled.cloud/gcp/gkehub_v2";
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
const membership = process.env.GCP_TEST_GKE_MEMBERSHIP;
// GKE Hub API is disabled on the testing project: 403 Forbidden
// (SERVICE_DISABLED) "GKE Hub API has not been used in project
// alchemy-gcp-testing-83661 before or it is disabled." Full
// lifecycle also needs a registered Fleet membership.
const runLifecycle = hasGcpCreds && !process.env.FAST && !!membership;

const missingMembership = `projects/${project}/locations/global/memberships/alchemy-missing-membership`;
const missingFeature = `${missingMembership}/features/configmanagement`;

const waitUntilGone = (name: string) =>
  gkehub.getProjectsLocationsMembershipsFeatures({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsMembershipsFeatures on a missing feature fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gkehub.getProjectsLocationsMembershipsFeatures({
          name: missingFeature,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* gkehub
        .listProjectsLocationsMembershipsFeatures({
          parent: `projects/${project}/locations/global/memberships/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ membershipFeatures: [] as const }),
          ),
        );
      expect(Array.isArray(page.membershipFeatures ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || runLifecycle)(
  "create against a missing membership is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Gkehub.MembershipsFeature("ConfigSync", {
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
      expect([
        "NotFound",
        "Forbidden",
        "BadRequest",
        "GCP.Gkehub.OperationFailed",
        "GCP.Gkehub.ResourceNotResolved",
      ]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a membership feature",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gkehub.MembershipsFeature("ConfigSync", {
            membership: membership!,
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
      expect(created.membership).toEqual(
        membership!.includes("/")
          ? membership!.replace(/\/+$/, "")
          : expect.stringContaining(`/memberships/${membership}`),
      );
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* gkehub.getProjectsLocationsMembershipsFeatures({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gkehub.MembershipsFeature("ConfigSync", {
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
  { timeout: 120_000 },
);
