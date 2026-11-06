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

// The test owns both buckets. Keep existing policy bindings when granting
// the Storage Insights service agent access to these fixtures.
const grantInventoryAccess = Effect.fn(function* (bucket: string, member: string) {
  const policy = yield* storage.getIamPolicyBuckets({ bucket });
  yield* storage.setIamPolicyBuckets({
    bucket,
    body: {
      ...policy,
      bindings: [
        ...(policy.bindings ?? []),
        { role: "roles/storage.insightsCollectorService", members: [member] },
        { role: "roles/storage.objectCreator", members: [member] },
      ],
    },
  });
});

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
      yield* grantInventoryAccess(fixtures.primary, member);
      yield* grantInventoryAccess(fixtures.secondary, member);
      yield* grantInventoryAccess(fixtures.alternate, member);

      const deploy = (parquet: boolean, secondary = false, alternate = false) =>
        stack.deploy(
          Effect.gen(function* () {
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
                  bucket: secondary ? names.secondary : alternate ? names.alternate : names.primary,
                  destinationPath: parquet ? "updated-inventory/" : "inventory/",
                },
              },
            });
          }),
        );

      const created = yield* deploy(false);
      const initial = yield* insights.getProjectsLocationsReportConfigs({ name: created.name });
      expect(initial.csvOptions?.delimiter).toEqual("|");
      expect(initial.csvOptions?.headerRequired).toEqual(true);
      expect(initial.labels?.["alchemy-id"]).toEqual(expect.any(String));

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

      const newSource = yield* deploy(true, false, true);
      expect(newSource.name).not.toEqual(created.name);
      expect(newSource.location).toEqual(created.location);
      const sourceFetched = yield* insights.getProjectsLocationsReportConfigs({
        name: newSource.name,
      });
      expect(sourceFetched.objectMetadataReportOptions?.storageFilters?.bucket).toEqual(
        fixtures.alternate,
      );

      const replaced = yield* deploy(true, true);
      expect(replaced.name).not.toEqual(created.name);
      expect(replaced.location).toEqual("us-east1");
      const oldGone = yield* insights
        .getProjectsLocationsReportConfigs({ name: created.name })
        .pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        );
      expect(oldGone).toEqual(true);

      yield* stack.destroy();
      const gone = yield* insights.getProjectsLocationsReportConfigs({ name: replaced.name }).pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      );
      expect(gone).toEqual(true);
    }),
  { tags: ["provider:gcp", "provider:gcp:storageinsights", "live"], timeout: 120_000 },
);
