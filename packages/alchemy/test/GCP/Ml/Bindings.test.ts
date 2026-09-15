import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  region,
  runLifecycle,
  runVersionLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!runLifecycle)(
  "GetModel invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const model = yield* GCP.Ml.Model("Classifier", {
            description: "binding probe",
            regions: [region],
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* model.name;
              const getModel = yield* GCP.Ml.GetModel(model);
              const predict = yield* GCP.Ml.Predict(model);
              return Effect.fn(function* () {
                const live = yield* getModel();
                const prediction = yield* predict({
                  body: {
                    httpBody: {
                      contentType: "application/json",
                      data: btoa(JSON.stringify({ instances: [{ f1: 1 }] })),
                    },
                  },
                }).pipe(
                  Effect.map((result) => ({ tag: "ok" as const, result })),
                  Effect.catchTag(
                    ["Forbidden", "BadRequest", "NotFound", "Conflict"],
                    (error) =>
                      Effect.succeed({
                        tag: error._tag,
                        message: error.message,
                      }),
                  ),
                );
                return { live, prediction };
              });
            }),
          );
          return { model, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.model.name);
      expect([
        "ok",
        "Forbidden",
        "BadRequest",
        "NotFound",
        "Conflict",
      ]).toContain(out.probe.prediction.tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runVersionLifecycle)(
  "GetVersion invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploymentUri = process.env.GCP_TEST_ML_DEPLOYMENT_URI ?? "";

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const model = yield* GCP.Ml.Model("Classifier", {
            description: "binding probe",
            regions: [region],
          });
          const version = yield* GCP.Ml.ModelsVersion("V1", {
            model: model.name,
            deploymentUri,
            runtimeVersion: "2.11",
            pythonVersion: "3.7",
            framework: "TENSORFLOW",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* version.name;
              const getVersion = yield* GCP.Ml.GetVersion(version);
              return Effect.fn(function* () {
                return yield* getVersion();
              });
            }),
          );
          return { version, live: yield* Probe({}) };
        }),
      );

      expect(out.live.name).toEqual(out.version.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
