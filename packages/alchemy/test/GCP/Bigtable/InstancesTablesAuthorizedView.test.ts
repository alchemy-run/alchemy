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
  bigtable.getProjectsInstancesTablesAuthorizedViews({ name }).pipe(
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
  "getProjectsInstancesTablesAuthorizedViews on a missing instance fails with Forbidden or NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        bigtable.getProjectsInstancesTablesAuthorizedViews({
          name: `projects/${project}/instances/alchemybtmissing/tables/missing/authorizedViews/missing`,
        }),
      );
      expect(error._tag).toBeOneOf(["Forbidden", "NotFound"]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a bigtable authorized view",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Bigtable.Instance("Data", {
            displayName: "alchemy-test-bt-authview",
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
            columnFamilies: { cf: { gcRule: { maxNumVersions: 1 } } },
          });
          const view = yield* GCP.Bigtable.InstancesTablesAuthorizedView(
            "Public",
            {
              instance: instance.name,
              table: table.name,
              subsetView: {
                rowPrefixes: [""],
                familySubsets: {
                  cf: { qualifierPrefixes: [""] },
                },
              },
            },
          );
          return { instance, table, view };
        }),
      );

      expect(created.view.name).toContain("/authorizedViews/");
      expect(created.view.authorizedViewId).toEqual(expect.any(String));
      expect(created.view.table).toEqual(created.table.name);
      expect(created.view.deletionProtection).toEqual(false);
      expect(created.view.subsetView?.familySubsets?.cf).toBeDefined();

      const fetched = yield* bigtable.getProjectsInstancesTablesAuthorizedViews(
        {
          name: created.view.name,
          view: "FULL",
        },
      );
      expect(fetched.name).toEqual(created.view.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Bigtable.Instance("Data", {
            instanceId: created.instance.instanceId,
            displayName: "alchemy-test-bt-authview",
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
            tableId: created.table.tableId,
            columnFamilies: { cf: { gcRule: { maxNumVersions: 1 } } },
          });
          const view = yield* GCP.Bigtable.InstancesTablesAuthorizedView(
            "Public",
            {
              instance: instance.name,
              table: table.name,
              authorizedViewId: created.view.authorizedViewId,
              subsetView: {
                rowPrefixes: [""],
                familySubsets: {
                  cf: { qualifierPrefixes: [""] },
                },
              },
              deletionProtection: true,
            },
          );
          return { instance, table, view };
        }),
      );

      expect(updated.view.name).toEqual(created.view.name);
      expect(updated.view.deletionProtection).toEqual(true);

      const refetched =
        yield* bigtable.getProjectsInstancesTablesAuthorizedViews({
          name: created.view.name,
          view: "FULL",
        });
      expect(refetched.deletionProtection).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.view.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
