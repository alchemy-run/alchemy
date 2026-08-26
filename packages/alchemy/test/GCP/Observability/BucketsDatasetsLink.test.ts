import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as observability from "@distilled.cloud/gcp/observability_v1";
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

const defaultDataset = `projects/${project}/locations/us-central1/buckets/_Trace/datasets/Spans`;

// Observability API is entitlement-gated on the default testing project.
// Live create returns Forbidden: "Observability API has not been used in
// project alchemy-gcp-testing-83661 before or it is disabled." Link
// create is also an LRO that provisions a BigQuery linked dataset. Set
// GCP_TEST_OBSERVABILITY=1 on an entitled project to run the lifecycle.
const entitled = process.env.GCP_TEST_OBSERVABILITY === "1";
const runLifecycle = hasGcpCreds && entitled && !process.env.FAST;

const waitUntilGone = (name: string) =>
  observability.getProjectsLocationsBucketsDatasetsLinks({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const findSpansDataset = Effect.gen(function* () {
  const locations = ["us-central1", "global", "-"] as const;
  for (const location of locations) {
    const buckets = yield* observability
      .listProjectsLocationsBuckets({
        parent: `projects/${project}/locations/${location}`,
        pageSize: 100,
      })
      .pipe(
        Effect.map((page) => page.buckets ?? []),
        Effect.catchTag(["NotFound", "Forbidden"], () =>
          Effect.succeed([] as observability.Bucket[]),
        ),
      );
    for (const bucket of buckets) {
      if (!bucket.name) continue;
      const datasets = yield* observability
        .listProjectsLocationsBucketsDatasets({
          parent: bucket.name,
          pageSize: 100,
        })
        .pipe(
          Effect.map((page) => page.datasets ?? []),
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed([] as observability.Dataset[]),
          ),
        );
      const spans = datasets.find((dataset) =>
        (dataset.name ?? "").endsWith("/datasets/Spans"),
      );
      if (spans?.name) return spans.name;
      if (datasets[0]?.name) return datasets[0].name;
    }
  }
  return defaultDataset;
});

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsBucketsDatasetsLinks on a missing link fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        observability.getProjectsLocationsBucketsDatasetsLinks({
          name: `${defaultDataset}/links/alchemy-missing-link`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain("Observability API has not been used");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an observability dataset link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const dataset = yield* findSpansDataset;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Observability.BucketsDatasetsLink("Analytics", {
            dataset,
            description: "bigquery analytics",
            displayName: "Trace analytics",
          });
        }),
      );

      expect(created.linkId).toEqual(expect.any(String));
      expect(created.linkId).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(created.dataset).toEqual(dataset);
      expect(created.project).toEqual(project);
      expect(created.name).toEqual(`${dataset}/links/${created.linkId}`);
      expect(created.description).toEqual("bigquery analytics");
      expect(created.displayName).toEqual("Trace analytics");

      const fetched =
        yield* observability.getProjectsLocationsBucketsDatasetsLinks({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("bigquery analytics");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Observability.BucketsDatasetsLink("Analytics", {
            dataset,
            linkId: created.linkId,
            description: "updated analytics",
            displayName: "Updated traces",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated analytics");
      expect(updated.displayName).toEqual("Updated traces");

      const fetchedUpdate =
        yield* observability.getProjectsLocationsBucketsDatasetsLinks({
          name: created.name,
        });
      expect(fetchedUpdate.description).toContain("updated analytics");
      expect(fetchedUpdate.displayName).toEqual("Updated traces");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
