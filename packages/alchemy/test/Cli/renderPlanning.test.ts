import { expect, it } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import { Progress } from "@/Alchemist/Progress.ts";
import * as CliKit from "@/Cli/CliKit/index.ts";
import { renderPlanning } from "@/Cli/commands/render.ts";
import { LoggingCli } from "@/Cli/LoggingCli.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";

class Boom extends Data.TaggedError("Boom")<{ message: string }> {}

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

it.effect(
  "names slow and failed diffs in plain planning output",
  () => {
    const messages: string[] = [];
    const logger = Logger.make<unknown, void>((options) => {
      messages.push(stripAnsi(String((options.message as unknown[])[0])));
    });
    const started = (fqn: string) => ({
      _tag: "plan.resource.started" as const,
      fqn,
      logicalId: fqn,
      resourceType: "Test.Thing",
      total: 2,
    });
    const failed = (fqn: string, message: string) => ({
      _tag: "plan.resource.failed" as const,
      fqn,
      logicalId: fqn,
      resourceType: "Test.Thing",
      message,
    });
    const plan = Effect.gen(function* () {
      const progress = yield* Progress;
      yield* progress({ _tag: "plan.phase", phase: "computing-plan" });
      yield* progress(started("Fast"));
      yield* progress(started("Slow"));
      yield* progress(failed("Fast", "Boom: fast failure"));
      // a diff stuck retrying a cloud call
      yield* Effect.sleep("45 seconds");
      yield* progress(failed("Slow", "GatewayTimeout: 504 Gateway time-out"));
      return yield* new Boom({ message: "fast failure" });
    });
    return Effect.gen(function* () {
      const fiber = yield* plan.pipe(
        renderPlanning({ operation: "Deploy", stage: "test" }),
        Effect.forkChild,
      );
      yield* TestClock.adjust("45 seconds");
      yield* Fiber.await(fiber);

      expect(messages.some((line) => line.startsWith("Still planning Slow"))).toBe(true);
      expect(messages.at(-1)).toContain(
        "Planning failed: Fast (Test.Thing): Boom: fast failure (+1 more failed)",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.provide(LoggingCli, PlatformServices),
          CliKit.layer({ input: false }),
          Logger.layer([logger]),
        ),
      ),
    );
  },
  { tags: ["unit", "local"] },
);
