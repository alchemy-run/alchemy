import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apigee from "@distilled.cloud/gcp/apigee_v1";
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
  hasGcpCreds && !!process.env.GCP_TEST_APIGEE && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const org = `organizations/${project}`;

const waitUntilGone = (name: string) =>
  apigee.getOrganizationsAnalyticsDatastores({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getOrganizationsAnalyticsDatastores on a missing datastore fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsAnalyticsDatastores({
          name: `${org}/analytics/datastores/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an analytics datastore",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.AnalyticsDatastore("Exports", {
            targetType: "gcs",
            displayName: "alchemy exports",
            datastoreConfig: {
              projectId: project,
              bucketName: "apigee-analytics",
              path: "exports",
            },
          });
        }),
      );

      expect(created.datastoreId).toEqual(expect.any(String));
      expect(created.displayName).toEqual("alchemy exports");
      expect(created.targetType).toEqual("gcs");

      const fetched = yield* apigee.getOrganizationsAnalyticsDatastores({
        name: created.name,
      });
      expect(fetched.displayName).toContain("alchemy-id=");
      expect(fetched.displayName).toContain("alchemy exports");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.AnalyticsDatastore("Exports", {
            targetType: "gcs",
            displayName: "alchemy exports updated",
            datastoreConfig: {
              projectId: project,
              bucketName: "apigee-analytics",
              path: "exports-v2",
            },
          });
        }),
      );

      expect(updated.datastoreId).toEqual(created.datastoreId);
      expect(updated.displayName).toEqual("alchemy exports updated");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
