import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity, Workflow } from "effect/workflow";
import { Journal } from "../../../../Workflows/conformance/journal.ts";

/**
 * An activity that outlasts its step's timeout. Cloudflare's default step
 * timeout is 10 minutes, so it only fails when `withStepConfig` reaches
 * `step.do`; with no retries, its first attempt is its last.
 */
export const StepTimeout = Workflow.make("StepTimeout", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

export const StepTimeoutLive = Workflows.layer(
  StepTimeout,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id }) {
      return yield* Activity.make({
        name: "slow",
        success: Schema.String,
        execute: journal
          .append(id, "slow")
          .pipe(Effect.andThen(Effect.sleep("15 seconds")), Effect.as("finished")),
      }).pipe(
        Cloudflare.Workflows.withStepConfig({
          timeout: "2 seconds",
          retries: { limit: 0, delay: 0 },
        }),
      );
    });
  }),
);
