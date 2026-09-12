import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
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
  !process.env.FAST &&
  !!(process.env.GCP_TEST_AIPLATFORM || process.env.GCP_TEST_VERTEX);

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const parent = `projects/${project}/locations/us-central1`;

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsIndexes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const indexMetadata = {
  config: {
    dimensions: 8,
    approximateNeighborsCount: 10,
    distanceMeasureType: "DOT_PRODUCT_DISTANCE",
    shardSize: "SHARD_SIZE_SMALL",
    algorithmConfig: { bruteForceConfig: {} },
  },
};

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsIndexes on a missing index fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsIndexes({
          name: `${parent}/indexes/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
      if (String(error._tag) === "BadRequest") {
        yield* stack.destroy();
        return;
      }

      const page = yield* aiplatform
        .listProjectsLocationsIndexes({
          parent,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["Forbidden"], () =>
            Effect.succeed({ indexes: [] as const }),
          ),
        );
      expect(Array.isArray(page.indexes ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a matching engine index",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.Index("Embeddings", {
            location: "us-central1",
            displayName: "alchemy-index",
            description: "embeddings",
            indexUpdateMethod: "STREAM_UPDATE",
            metadata: indexMetadata,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/indexes/");
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.description).toEqual("embeddings");

      const fetched = yield* aiplatform.getProjectsLocationsIndexes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.Index("Embeddings", {
            location: "us-central1",
            displayName: "alchemy-index",
            description: "embeddings-v2",
            indexUpdateMethod: "STREAM_UPDATE",
            metadata: indexMetadata,
            labels: { env: "prod", role: "search" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("embeddings-v2");
      expect(updated.labels).toMatchObject({ env: "prod", role: "search" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
