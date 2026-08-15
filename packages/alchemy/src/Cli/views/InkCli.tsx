/** @jsxImportSource react */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Plan } from "../../Plan.ts";
import { type PlanStatusSession, Cli } from "../Cli.ts";
import { Box } from "../CliKit/components.ts";
import { CliKit } from "../CliKit/index.ts";
import type { ApplyEvent } from "../Event.ts";
import { approvePlanScreen } from "./ApprovePlan.tsx";
import { Plan as PlanComponent } from "./Plan.tsx";
import { PlanProgress, PlanProgressStore } from "./PlanProgress.tsx";

export const inkCLI = () =>
  Layer.succeed(
    Cli,
    Cli.of({
      approvePlan,
      displayPlan,
      startApplySession,
    }),
  );

const approvePlan = Effect.fn(function* <P extends Plan>(plan: P) {
  const cli = yield* CliKit;
  return yield* cli.prompt.custom(approvePlanScreen(plan)).pipe(
    Effect.catchTag("TerminalCancelled", () => Effect.succeed(false)),
    Effect.orDie,
  );
});

const displayPlan = Effect.fn(function* <P extends Plan>(plan: P) {
  const cli = yield* CliKit;
  // Plan carries no outer margin of its own; give the printed plan the same
  // breathing room the approval screen adds.
  yield* cli.output.print(
    <Box marginTop={1}>
      <PlanComponent plan={plan} />
    </Box>,
  );
});

const startApplySession = Effect.fn(function* <P extends Plan>(plan: P) {
  const cli = yield* CliKit;
  const progress = new PlanProgressStore(plan);
  const live = yield* cli.live.open(<PlanProgress store={progress} />, {
    persistOnClose: true,
  });
  return {
    done: (outcome) =>
      Effect.sync(() => progress.finish(outcome)).pipe(
        Effect.andThen(live.close),
      ),
    emit: (event: ApplyEvent) => Effect.sync(() => progress.emit(event)),
  } satisfies PlanStatusSession;
});
