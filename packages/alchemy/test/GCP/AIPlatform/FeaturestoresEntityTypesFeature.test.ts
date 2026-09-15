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

const waitUntilGone = (name: string) =>
  aiplatform
    .getProjectsLocationsFeaturestoresEntityTypesFeatures({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsFeaturestoresEntityTypesFeatures on a missing feature fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsFeaturestoresEntityTypesFeatures({
          name: `projects/${project}/locations/us-central1/featurestores/alchemy-missing/entityTypes/alchemy-missing/features/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a featurestore entity type feature",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.AIPlatform.Featurestore("Features", {
            location: "us-central1",
            labels: { env: "test" },
          });
          const entity = yield* GCP.AIPlatform.FeaturestoresEntityType("User", {
            featurestore: store.name,
            location: "us-central1",
            description: "end users",
            labels: { env: "test" },
          });
          const feature = yield* GCP.AIPlatform.FeaturestoresEntityTypesFeature(
            "Age",
            {
              entityType: entity.name,
              valueType: "INT64",
              description: "customer age",
              labels: { env: "test" },
            },
          );
          return { store, entity, feature };
        }),
      );

      expect(created.feature.name).toContain("/features/");
      expect(created.feature.entityType).toEqual(created.entity.name);
      expect(created.feature.valueType).toEqual("INT64");
      expect(created.feature.description).toEqual("customer age");
      expect(created.feature.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* aiplatform.getProjectsLocationsFeaturestoresEntityTypesFeatures({
          name: created.feature.name,
        });
      expect(fetched.name).toEqual(created.feature.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.AIPlatform.Featurestore("Features", {
            featurestoreId: created.store.featurestoreId,
            location: "us-central1",
            labels: { env: "test" },
          });
          const entity = yield* GCP.AIPlatform.FeaturestoresEntityType("User", {
            featurestore: store.name,
            entityTypeId: created.entity.entityTypeId,
            location: "us-central1",
            description: "end users",
            labels: { env: "test" },
          });
          const feature = yield* GCP.AIPlatform.FeaturestoresEntityTypesFeature(
            "Age",
            {
              entityType: entity.name,
              featureId: created.feature.featureId,
              valueType: "INT64",
              description: "customer age v2",
              labels: { env: "prod" },
            },
          );
          return { store, entity, feature };
        }),
      );

      expect(updated.feature.name).toEqual(created.feature.name);
      expect(updated.feature.description).toEqual("customer age v2");
      expect(updated.feature.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.feature.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
