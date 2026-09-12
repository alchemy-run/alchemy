import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
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

// Stop→TERMINATED on e2-micro often exceeds 60s. Set
// GCP_TEST_COMPUTE_BINDINGS=1 to run the round-trip.
const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_COMPUTE_BINDINGS && !process.env.FAST;

test.provider.skipIf(!runLifecycle)(
  "GetInstance, StopInstance, and StartInstance round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const vm = yield* GCP.Compute.Instance("Vm", {
            zone: "us-central1-a",
            machineType: "e2-micro",
            associatePublicIp: false,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* vm.instanceName;
              const getInstance = yield* GCP.Compute.GetInstance(vm);
              const stopInstance = yield* GCP.Compute.StopInstance(vm);
              const startInstance = yield* GCP.Compute.StartInstance(vm);
              return Effect.fn(function* () {
                const live = yield* getInstance();
                yield* stopInstance();
                const stopped = yield* getInstance().pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced("3 seconds"),
                    until: (current) => current.status === "TERMINATED",
                    times: 16,
                  }),
                );
                yield* startInstance();
                const started = yield* getInstance().pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced("3 seconds"),
                    until: (current) => current.status === "RUNNING",
                    times: 16,
                  }),
                );
                return { live, stopped, started };
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(out.live.name).toEqual(expect.any(String));
      expect(out.stopped.status).toEqual("TERMINATED");
      expect(out.started.status).toEqual("RUNNING");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
