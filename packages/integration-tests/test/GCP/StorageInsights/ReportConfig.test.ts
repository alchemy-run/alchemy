import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as storageinsights from "@distilled.cloud/gcp/storageinsights_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const location = "us-central1";

const StorageInsightsApi = GCP.ServiceUsage.ProjectService("StorageInsightsApi", {
  service: "storageinsights.googleapis.com",
});

const inventory = (props: {
  displayName: string;
  endDate: string;
  labels: Record<string, string>;
}) =>
  Effect.gen(function* () {
    yield* StorageInsightsApi;
    const source = yield* GCP.Storage.Bucket("Source", {
      location: "US-CENTRAL1",
      forceDestroy: true,
    });
    const reports = yield* GCP.Storage.Bucket("Reports", {
      location: "US-CENTRAL1",
      forceDestroy: true,
    });
    return yield* GCP.StorageInsights.ReportConfig("Inventory", {
      location,
      sourceBucket: source.bucketName,
      destinationBucket: reports.bucketName,
      destinationPath: "inventory",
      startDate: "2027-01-01",
      ...props,
    });
  });

const waitUntilGone = (name: string) =>
  storageinsights.getProjectsLocationsReportConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 15,
    }),
  );

test.provider(
  "getProjectsLocationsReportConfigs on a missing config fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      yield* stack.deploy(StorageInsightsApi);

      const error = yield* Effect.flip(
        storageinsights.getProjectsLocationsReportConfigs({
          name: `projects/${project}/locations/${location}/reportConfigs/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:storageinsights", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete an inventory report config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        inventory({ displayName: "inventory", endDate: "2027-06-30", labels: { env: "test" } }),
      );
      expect(created.name).toContain("/reportConfigs/");
      expect(created.location).toEqual(location);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* storageinsights.getProjectsLocationsReportConfigs({
        name: created.name,
      });
      expect(fetched.displayName).toEqual("inventory");
      expect(fetched.frequencyOptions?.endDate).toMatchObject({ year: 2027, month: 6, day: 30 });
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const unchanged = yield* stack.plan(
        inventory({ displayName: "inventory", endDate: "2027-06-30", labels: { env: "test" } }),
      );
      expect(unchanged.resources.Inventory?.action).toEqual("noop");

      // Name, schedule and labels update in place.
      const updated = yield* stack.deploy(
        inventory({ displayName: "inventory v2", endDate: "2027-12-31", labels: { env: "prod" } }),
      );
      expect(updated.name).toEqual(created.name);
      const refetched = yield* storageinsights.getProjectsLocationsReportConfigs({
        name: created.name,
      });
      expect(refetched.displayName).toEqual("inventory v2");
      expect(refetched.frequencyOptions?.endDate).toMatchObject({ year: 2027, month: 12, day: 31 });
      expect(refetched.labels?.env).toEqual("prod");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:storageinsights", "live"], timeout: 300_000 },
);
