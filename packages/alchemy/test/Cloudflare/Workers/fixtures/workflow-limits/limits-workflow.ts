import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";

/** Step limit declared on {@link LimitsWorkflow}. */
export const STEP_LIMIT = 250;

/**
 * Fixture workflow used by `Workflow.test.ts`. Declares a per-workflow step
 * limit through the Effect-native form's third argument.
 */
export default class LimitsWorkflow extends Cloudflare.Workflow<LimitsWorkflow>()(
  "LimitsWorkflow",
  Effect.gen(function* () {
    return Effect.fn(function* (input: { value: string }) {
      return yield* Cloudflare.Workflows.task(
        "greet",
        Effect.succeed({ greeting: `Hello, ${input.value}!` }),
      );
    });
  }),
  { limits: { steps: STEP_LIMIT } },
) {}
