import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Fly.providers() });

test.provider(
  "a rejected candidate create preserves the active generation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (image: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("Site");
            return yield* Fly.Machine("Worker", {
              app,
              image,
              deploy: { strategy: "bluegreen", healthTimeout: "30 seconds" },
              shutdown: { signal: "SIGQUIT", timeout: "10 seconds" },
              checks: {
                ready: {
                  type: "http",
                  port: 80,
                  path: "/",
                  interval: "2s",
                  timeout: "1s",
                },
              },
            });
          }),
        );
      const initial = yield* deploy("nginx:alpine");
      const failed = yield* deploy(
        "nginx:alchemy-bluegreen-nonexistent-image",
      ).pipe(Effect.result);
      expect(Result.isFailure(failed)).toBe(true);
      if (Result.isFailure(failed))
        expect(failed.failure).toMatchObject({ _tag: "BadRequest" });
      const live = (yield* machines.listMachines({
        app_name: initial.appName,
      })).filter((machine) => machine.state !== "destroyed");
      expect(live.map((machine) => machine.id)).toEqual(initial.machineIds);
      expect(live[0]?.state).toBe("started");
      expect(live[0]?.cordoned).toBe(false);
      expect(live[0]?.config?.metadata?.["alchemy.phase"]).toBe("active");
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
