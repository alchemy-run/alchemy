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
  aiplatform.getProjectsLocationsMetadataStoresArtifacts({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsMetadataStoresArtifacts on a missing artifact fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsMetadataStoresArtifacts({
          name: `projects/${project}/locations/us-central1/metadataStores/alchemy-missing/artifacts/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a metadata store artifact",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.AIPlatform.MetadataStore("Mlmd", {
            location: "us-central1",
            description: "pipeline metadata",
          });
          const artifact = yield* GCP.AIPlatform.MetadataStoresArtifact(
            "Model",
            {
              metadataStore: store.name,
              displayName: "trained-model",
              description: "first",
              uri: "gs://alchemy-aiplatform-test/model",
              state: "LIVE",
              labels: { env: "test" },
            },
          );
          return { store, artifact };
        }),
      );

      expect(created.artifact.name).toContain("/artifacts/");
      expect(created.artifact.metadataStore).toEqual(created.store.name);
      expect(created.artifact.displayName).toEqual("trained-model");
      expect(created.artifact.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* aiplatform.getProjectsLocationsMetadataStoresArtifacts({
          name: created.artifact.name,
        });
      expect(fetched.name).toEqual(created.artifact.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.AIPlatform.MetadataStore("Mlmd", {
            metadataStoreId: created.store.metadataStoreId,
            location: "us-central1",
            description: "pipeline metadata",
          });
          const artifact = yield* GCP.AIPlatform.MetadataStoresArtifact(
            "Model",
            {
              metadataStore: store.name,
              artifactId: created.artifact.artifactId,
              displayName: "trained-model-v2",
              description: "second",
              uri: "gs://alchemy-aiplatform-test/model-v2",
              state: "LIVE",
              labels: { env: "prod" },
            },
          );
          return { store, artifact };
        }),
      );

      expect(updated.artifact.name).toEqual(created.artifact.name);
      expect(updated.artifact.displayName).toEqual("trained-model-v2");
      expect(updated.artifact.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.artifact.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
