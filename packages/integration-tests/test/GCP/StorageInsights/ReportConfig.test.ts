import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as projects from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as insights from "@distilled.cloud/gcp/storageinsights_v1";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: GCP.providers() });

const buckets = Effect.gen(function* () {
  const primary = yield* GCP.Storage.Bucket("Primary", {
    location: "us-central1",
    uniformBucketLevelAccess: true,
    forceDestroy: true,
  });
  const alternate = yield* GCP.Storage.Bucket("Alternate", {
    location: "us-central1",
    uniformBucketLevelAccess: true,
    forceDestroy: true,
  });
  const secondary = yield* GCP.Storage.Bucket("Secondary", {
    location: "us-east1",
    uniformBucketLevelAccess: true,
    forceDestroy: true,
  });
  return {
    primary: primary.bucketName,
    alternate: alternate.bucketName,
    secondary: secondary.bucketName,
  };
});

const frequencyOptions = {
  frequency: "DAILY",
  startDate: { year: 2090, month: 1, day: 1 },
  endDate: { year: 2091, month: 1, day: 1 },
};

test.provider(
  "create, update format, replace location, and delete inventory configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fixtures = yield* stack.deploy(buckets);
      const env = yield* GcpEnvironment.current;
      const project = yield* projects.getProjects({ name: `projects/${env.project}` });
      const projectNumber = project.name!.split("/")[1];
      const member = `serviceAccount:service-${projectNumber}@gcp-sa-storageinsights.iam.gserviceaccount.com`;
      const rolesOf = Effect.fn(function* (bucket: string) {
        const policy = yield* storage.getIamPolicyBuckets({ bucket });
        return (policy.bindings ?? [])
          .filter((binding) => binding.members?.includes(member))
          .map((binding) => binding.role);
      });

      const isGone = (name: string) =>
        insights.getProjectsLocationsReportConfigs({ name }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        );

      const inventory = Effect.fn(function* (
        parquet: boolean,
        secondary = false,
        alternate = false,
        moved = false,
      ) {
        const names = yield* buckets;
        return yield* GCP.StorageInsights.ReportConfig("Inventory", {
          location: secondary ? "us-east1" : "us-central1",
          displayName: parquet ? "Updated inventory" : "Initial inventory",
          labels: parquet ? { phase: "updated" } : { phase: "initial", removed: "yes" },
          frequencyOptions: { ...frequencyOptions, frequency: parquet ? "WEEKLY" : "DAILY" },
          ...(parquet
            ? { parquetOptions: {} }
            : { csvOptions: { delimiter: "|", headerRequired: true } }),
          objectMetadataReportOptions: {
            metadataFields: parquet
              ? ["project", "bucket", "name", "size", "generation", "storageClass"]
              : ["project", "bucket", "name", "size", "generation"],
            storageFilters: {
              bucket: secondary ? names.secondary : alternate ? names.alternate : names.primary,
            },
            storageDestinationOptions: {
              bucket: secondary
                ? names.secondary
                : alternate || moved
                  ? names.alternate
                  : names.primary,
              destinationPath: parquet ? "updated-inventory/" : "inventory/",
            },
          },
        });
      });
      const deploy = (parquet: boolean, secondary = false, alternate = false, moved = false) =>
        stack.deploy(inventory(parquet, secondary, alternate, moved));

      const created = yield* deploy(false);
      const initial = yield* insights.getProjectsLocationsReportConfigs({ name: created.name });
      expect(initial.csvOptions?.delimiter).toEqual("|");
      expect(initial.csvOptions?.headerRequired).toEqual(true);
      expect(initial.labels?.["alchemy-id"]).toEqual(expect.any(String));
      // The deploy granted the service agent read and write on the bucket.
      expect(yield* rolesOf(fixtures.primary)).toEqual(
        expect.arrayContaining([
          "roles/storage.insightsCollectorService",
          "roles/storage.objectCreator",
        ]),
      );

      // Recover the server-assigned UUID without its cached output.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({ stack: stack.name, stage: stack.stage, fqn: "Inventory" });
      }).pipe(Effect.provide(stack.state));

      const updated = yield* deploy(true);
      expect(updated.name).toEqual(created.name);
      const fetched = yield* insights.getProjectsLocationsReportConfigs({ name: updated.name });
      expect(fetched.parquetOptions).toEqual({});
      expect(fetched.csvOptions).toBeUndefined();
      expect(fetched.frequencyOptions?.frequency).toEqual("WEEKLY");
      expect(fetched.displayName).toEqual("Updated inventory");
      expect(fetched.labels?.phase).toEqual("updated");
      expect(fetched.labels?.removed).toBeUndefined();
      expect(fetched.objectMetadataReportOptions?.storageFilters).toEqual(
        initial.objectMetadataReportOptions?.storageFilters,
      );
      expect(fetched.objectMetadataReportOptions?.metadataFields).toContain("storageClass");
      expect(
        fetched.objectMetadataReportOptions?.storageDestinationOptions?.destinationPath,
      ).toEqual("updated-inventory/");

      const redeployed = yield* deploy(true);
      expect(redeployed.name).toEqual(updated.name);
      const unchanged = yield* insights.getProjectsLocationsReportConfigs({ name: updated.name });
      expect(unchanged.updateTime).toEqual(fetched.updateTime);

      // Moving the destination updates in place and moves the write grant.
      const moved = yield* deploy(true, false, false, true);
      expect(moved.name).toEqual(created.name);
      expect(moved.objectMetadataReportOptions?.storageDestinationOptions?.bucket).toEqual(
        fixtures.alternate,
      );
      expect(yield* rolesOf(fixtures.primary)).toEqual(["roles/storage.insightsCollectorService"]);
      expect(yield* rolesOf(fixtures.alternate)).toEqual(["roles/storage.objectCreator"]);

      const newSource = yield* deploy(true, false, true);
      expect(newSource.name).not.toEqual(created.name);
      expect(newSource.location).toEqual(created.location);
      expect(yield* isGone(created.name)).toEqual(true);
      const sourceFetched = yield* insights.getProjectsLocationsReportConfigs({
        name: newSource.name,
      });
      expect(sourceFetched.objectMetadataReportOptions?.storageFilters?.bucket).toEqual(
        fixtures.alternate,
      );
      // Replacing the configuration released the agent from the bucket it left.
      expect(yield* rolesOf(fixtures.primary)).toEqual([]);
      expect(yield* rolesOf(fixtures.alternate)).toEqual(
        expect.arrayContaining([
          "roles/storage.insightsCollectorService",
          "roles/storage.objectCreator",
        ]),
      );

      const replaced = yield* deploy(true, true);
      expect(replaced.name).not.toEqual(created.name);
      expect(replaced.location).toEqual("us-east1");
      expect(yield* isGone(newSource.name)).toEqual(true);
      expect(yield* rolesOf(fixtures.alternate)).toEqual([]);
      expect(yield* rolesOf(fixtures.secondary)).toHaveLength(2);

      // A second configuration on the same bucket keeps the agent's roles
      // when the first one is deleted.
      const neighbor = Effect.fn(function* () {
        const names = yield* buckets;
        return yield* GCP.StorageInsights.ReportConfig("Neighbor", {
          location: "us-east1",
          frequencyOptions,
          parquetOptions: {},
          objectMetadataReportOptions: {
            metadataFields: ["project", "bucket", "name"],
            storageFilters: { bucket: names.secondary },
            storageDestinationOptions: {
              bucket: names.secondary,
              destinationPath: "neighbor/",
            },
          },
        });
      });
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* inventory(true, true);
          return yield* neighbor();
        }),
      );
      const remaining = yield* stack.deploy(neighbor());
      expect(yield* isGone(replaced.name)).toEqual(true);
      expect(yield* rolesOf(fixtures.secondary)).toHaveLength(2);

      yield* stack.destroy();
      expect(yield* isGone(remaining.name)).toEqual(true);
    }),
  { tags: ["provider:gcp", "provider:gcp:storageinsights", "live"], timeout: 120_000 },
);
