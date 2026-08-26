import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as ml from "@distilled.cloud/gcp/ml_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  hasGcpCreds,
  logLevel,
  project,
  region,
  runLifecycle,
  runVersionLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  ml.getProjectsModelsVersions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsModelsVersions on a missing version fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        ml.getProjectsModelsVersions({
          name: `projects/${project}/models/alchemy-missing-model/versions/v1`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain(
          "AI Platform Training & Prediction API has not been used",
        );
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || runLifecycle)(
  "createProjectsModelsVersions is rejected with Forbidden when the ML API is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        ml.createProjectsModelsVersions({
          parent: `projects/${project}/models/alchemy-missing-model`,
          body: {
            name: "v1",
            deploymentUri: `gs://${project}-ml-missing/model`,
            description: "probe",
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain("has not been used in project");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runVersionLifecycle)(
  "create, update, and delete a model version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploymentUri = process.env.GCP_TEST_ML_DEPLOYMENT_URI ?? "";

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const model = yield* GCP.Ml.Model("Classifier", {
            description: "image classifier",
            regions: [region],
          });
          const version = yield* GCP.Ml.ModelsVersion("V1", {
            model: model.name,
            deploymentUri,
            runtimeVersion: "2.11",
            pythonVersion: "3.7",
            framework: "TENSORFLOW",
            description: "first version",
            labels: { env: "test" },
            autoScaling: { minNodes: 0 },
          });
          return { model, version };
        }),
      );

      expect(created.version.name).toContain("/versions/");
      expect(created.version.model).toEqual(created.model.name);
      expect(created.version.description).toEqual("first version");
      expect(created.version.deploymentUri).toEqual(deploymentUri);
      expect(created.version.labels).toMatchObject({ env: "test" });

      const fetched = yield* ml.getProjectsModelsVersions({
        name: created.version.name,
      });
      expect(fetched.name).toEqual(created.version.name);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("first version");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const model = yield* GCP.Ml.Model("Classifier", {
            modelId: created.model.modelId,
            description: "image classifier",
            regions: [region],
          });
          const version = yield* GCP.Ml.ModelsVersion("V1", {
            model: model.name,
            versionId: created.version.versionId,
            deploymentUri,
            runtimeVersion: "2.11",
            pythonVersion: "3.7",
            framework: "TENSORFLOW",
            description: "first version v2",
            autoScaling: { minNodes: 0 },
          });
          return { model, version };
        }),
      );

      expect(updated.version.name).toEqual(created.version.name);
      expect(updated.version.description).toEqual("first version v2");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.version.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
