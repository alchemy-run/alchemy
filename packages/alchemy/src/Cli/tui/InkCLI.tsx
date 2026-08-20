/** @jsxImportSource react */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { render } from "ink";
import type { Plan } from "../../Plan.ts";
import {
  type PlanDisplayOptions,
  type PlanStatusSession,
  Cli,
} from "../Cli.ts";
import type { ApplyEvent } from "../Event.ts";
import { ApprovePlan } from "./components/ApprovePlan.tsx";
import { Plan as PlanComponent } from "./components/Plan.tsx";
import { PlanProgress } from "./components/PlanProgress.tsx";

export const inkCLI = () =>
  Layer.succeed(
    Cli,
    Cli.of({
      approvePlan,
      displayPlan,
      startApplySession,
    }),
  );

const approvePlan = Effect.fn(function* <P extends Plan>(
  plan: P,
  options: PlanDisplayOptions = {},
) {
  let approved = false;
  const { waitUntilExit } = render(
    <ApprovePlan
      plan={plan}
      detailed={options.detailed}
      approve={(a) => (approved = a)}
    />,
  );
  yield* Effect.promise(waitUntilExit);
  return approved;
});

const displayPlan = <P extends Plan>(
  plan: P,
  options: PlanDisplayOptions = {},
): Effect.Effect<void> =>
  Effect.sync(() => {
    const { unmount } = render(
      <PlanComponent plan={plan} detailed={options.detailed} />,
    );
    unmount();
  });

const startApplySession = Effect.fn(function* <P extends Plan>(
  plan: P,
  options: PlanDisplayOptions = {},
) {
  // Print the plan preview once into scrollback before mounting the
  // animated progress region (mirrors LoggingCli, which prints the plan
  // lines at session start — `alchemy dev`/`--yes` runs never call
  // displayPlan/approvePlan, so without this the TTY path shows no plan at
  // all). Rendering + immediately unmounting leaves the frame behind and
  // releases the Ink instance for PlanProgress; forwarded runtime logs then
  // insert BETWEEN the preview and the live region instead of piling above
  // the entire transcript.
  yield* displayPlan(plan, options);
  const listeners = new Set<(event: ApplyEvent) => void>();
  const { unmount } = render(
    <PlanProgress
      plan={plan}
      source={{
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }}
    />,
  );
  return {
    done: Effect.fn(function* () {
      yield* Effect.sleep(10); // give the react event loop time to re-render
      yield* Effect.sync(() => unmount());
    }),
    emit: (event) =>
      Effect.sync(() => {
        for (const listener of listeners) listener(event);
      }),
  } satisfies PlanStatusSession;
});
