import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
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

// Cloud Bigtable Admin API is disabled on the default testing project
// (`Forbidden`: "Cloud Bigtable Admin API has not been used in project
// 457525637530 before or it is disabled."). Set GCP_TEST_BIGTABLE=1 on an
// entitled project to run the full lifecycle.
const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_BIGTABLE && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  bigtable.getProjectsInstancesLogicalViews({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsInstancesLogicalViews on a missing instance fails with Forbidden or NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        bigtable.getProjectsInstancesLogicalViews({
          name: `projects/${project}/instances/alchemybtmissing/logicalViews/missing`,
        }),
      );
      expect(error._tag).toBeOneOf(["Forbidden", "NotFound"]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a bigtable logical view",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Bigtable.Instance("Data", {
            displayName: "alchemy-test-bt-logical",
            type: "PRODUCTION",
            clusters: {
              cluster: {
                location: "us-central1-b",
                serveNodes: 1,
                defaultStorageType: "HDD",
              },
            },
          });
          const table = yield* GCP.Bigtable.Table("Users", {
            instance: instance.name,
            tableId: "users",
            columnFamilies: { cf: { gcRule: { maxNumVersions: 1 } } },
          });
          const view = yield* GCP.Bigtable.InstancesLogicalView("Active", {
            instance: instance.name,
            query: "SELECT _key FROM `users`",
          });
          return { instance, table, view };
        }),
      );

      expect(created.view.name).toContain("/logicalViews/");
      expect(created.view.logicalViewId).toEqual(expect.any(String));
      expect(created.view.instance).toEqual(created.instance.name);
      expect(created.view.query).toContain("users");
      expect(created.view.deletionProtection).toEqual(false);

      const fetched = yield* bigtable.getProjectsInstancesLogicalViews({
        name: created.view.name,
      });
      expect(fetched.name).toEqual(created.view.name);
      expect(fetched.query).toContain("users");

      const updatedQuery = "SELECT _key, cf FROM `users`";
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Bigtable.Instance("Data", {
            instanceId: created.instance.instanceId,
            displayName: "alchemy-test-bt-logical",
            type: "PRODUCTION",
            clusters: {
              cluster: {
                location: "us-central1-b",
                serveNodes: 1,
                defaultStorageType: "HDD",
              },
            },
          });
          const table = yield* GCP.Bigtable.Table("Users", {
            instance: instance.name,
            tableId: "users",
            columnFamilies: { cf: { gcRule: { maxNumVersions: 1 } } },
          });
          const view = yield* GCP.Bigtable.InstancesLogicalView("Active", {
            instance: instance.name,
            logicalViewId: created.view.logicalViewId,
            query: updatedQuery,
            deletionProtection: true,
          });
          return { instance, table, view };
        }),
      );

      expect(updated.view.name).toEqual(created.view.name);
      expect(updated.view.deletionProtection).toEqual(true);

      const refetched = yield* bigtable.getProjectsInstancesLogicalViews({
        name: created.view.name,
      });
      expect(refetched.deletionProtection).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.view.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
