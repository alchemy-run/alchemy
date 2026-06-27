import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * Fixture workflow used by `Workflow.test.ts`.
 *
 * Exercises:
 *  - `Cloudflare.Workflows.task` durable steps (greet + finalize)
 *  - `Cloudflare.Workflows.sleep` between steps
 *  - `Cloudflare.Workers.WorkerEnvironment` access from inside the body — regression
 *    guard for https://github.com/alchemy-run/alchemy-effect/pull/71
 */
export default class TestWorkflow extends Cloudflare.Workflow<TestWorkflow>()(
  "TestWorkflow",
  Effect.gen(function* () {
    return Effect.fn(function* (input: { value: string }) {
      const env = yield* Cloudflare.Workers.WorkerEnvironment;

      const greeted = yield* Cloudflare.Workflows.task(
        "greet",
        Effect.succeed(`Hello, ${input.value}!`),
      );

      yield* Cloudflare.Workflows.sleep("cooldown", "1 second");

      const finalized = yield* Cloudflare.Workflows.task(
        "finalize",
        Effect.succeed({
          greeting: greeted,
          envBindingCount: Object.keys(env).length,
        }),
      );

      return finalized;
    });
  }),
) {}
