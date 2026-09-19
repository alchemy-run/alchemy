import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

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
  hasGcpCreds && !!process.env.GCP_TEST_TPU && !process.env.FAST;

test.provider.skipIf(!runLifecycle)(
  "GetNode invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const node = yield* GCP.Tpu.Node("Trainer", {
            location: "us-central1-c",
            acceleratorType: "v2-8",
            runtimeVersion: "tpu-ubuntu2204-base",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* node.name;
              const getNode = yield* GCP.Tpu.GetNode(node);
              return Effect.fn(function* () {
                const live = yield* getNode();
                return { live };
              });
            }),
          );
          return { node, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.node.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!runLifecycle)(
  "GetQueuedResource invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const request = yield* GCP.Tpu.QueuedResource("Trainer", {
            location: "us-central1-c",
            nodeSpec: [
              {
                node: {
                  acceleratorType: "v2-8",
                  runtimeVersion: "tpu-ubuntu2204-base",
                },
              },
            ],
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* request.name;
              const getQueued = yield* GCP.Tpu.GetQueuedResource(request);
              return Effect.fn(function* () {
                const live = yield* getQueued();
                return { live };
              });
            }),
          );
          return { request, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.request.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
