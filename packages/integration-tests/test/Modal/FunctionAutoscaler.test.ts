import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as functions from "@distilled.cloud/modal/functions";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Modal.providers() });

const main = new URL("./fixtures/lifecycle-program.ts", import.meta.url).pathname;

const deployScaler = (maxContainers: number) =>
  Effect.gen(function* () {
    const environment = yield* Modal.Environment("ScalerEnv", {});
    const app = yield* Modal.App("ScalerApp", { environment });
    const fn = yield* Modal.Function("Scaled", { main, app });
    return yield* Modal.FunctionAutoscaler("Scaler", {
      app: app.name,
      function: fn.name,
      environment,
      maxContainers,
    });
  });

test.provider(
  "set a function's autoscaler, change it, and restore the original settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const scaler = yield* stack.deploy(deployScaler(3));
      const first = yield* functions.functionGetSchedulingParams({
        functionId: scaler.functionId,
      });
      expect(first.autoscalerConfiguration?.settings?.maxContainers).toBe(3);

      const changed = yield* stack.deploy(deployScaler(5));
      expect(changed.functionId).toBe(scaler.functionId);
      const second = yield* functions.functionGetSchedulingParams({
        functionId: scaler.functionId,
      });
      expect(second.autoscalerConfiguration?.settings?.maxContainers).toBe(5);

      // Removing the autoscaler alone hands the function back its own settings.
      yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* Modal.Environment("ScalerEnv", {});
          const app = yield* Modal.App("ScalerApp", { environment });
          return yield* Modal.Function("Scaled", { main, app });
        }),
      );
      const restored = yield* functions.functionGetSchedulingParams({
        functionId: scaler.functionId,
      });
      expect(restored.autoscalerConfiguration?.settings?.maxContainers).toBe(
        scaler.original.maxContainers,
      );

      yield* stack.destroy();
    }),
  { tags: ["provider:modal", "provider:modal:function", "live"], timeout: 300_000 },
);
