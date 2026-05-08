import * as Cloudflare from "@/Cloudflare";
import { inMemoryState } from "@/State";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const { test } = Test.make({ providers: Layer.empty });

const compileStack = <A, Err = never>(
  effect: Effect.Effect<A, Err, any>,
): Effect.Effect<Stack.CompiledStack<A>, Err> =>
  // @ts-expect-error - Stack.make's typing erases R unsoundly here
  effect.pipe(
    Stack.make({
      name: "test",
      providers: Layer.empty as unknown as Layer.Layer<any, never, any>,
      state: inMemoryState(),
    }),
    Effect.provideService(Stage, "test"),
  );

test(
  "worker bindings emit Cloudflare Analytics Engine metadata",
  Effect.gen(function* () {
    const stack = yield* Effect.gen(function* () {
      yield* Cloudflare.Worker("AnalyticsWorker", {
        main: "./worker.ts",
        bindings: {
          EVENTS: Cloudflare.AnalyticsEngineDataset("Events", {
            dataset: "app-events",
          }),
        },
      });
    }).pipe(compileStack);

    expect(stack.bindings.AnalyticsWorker).toEqual([
      {
        sid: "EVENTS",
        data: {
          bindings: [
            {
              type: "analytics_engine",
              name: "EVENTS",
              dataset: "app-events",
            },
          ],
        },
      },
    ]);
  }),
);
