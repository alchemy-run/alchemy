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
              return Effect.fn(function* () {
                return yield* getModel();
              });
            }),
          );
          return { model, live: yield* Probe({}) };
        }),
      );

      expect(out.live.name).toEqual(out.model.name);

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
