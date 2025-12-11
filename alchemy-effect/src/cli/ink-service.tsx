import React from "react";

import { type PlanStatusSession, CLI } from "./service.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IPlan } from "../plan.ts";
import { render } from "ink";
import { ApprovePlan } from "./components/ApprovePlan.tsx";
import { Plan } from "./components/Plan.tsx";
import { PlanProgress } from "./components/PlanProgress.tsx";
import type { ApplyEvent } from "../event.ts";

export const inkCLI = () =>
  Layer.succeed(
    CLI,
    CLI.of({
      approvePlan,
      displayPlan,
      startApplySession,
    }),
  );

const approvePlan = Effect.fn(function* <P extends IPlan>(plan: P) {
  let approved = false;
  const { waitUntilExit } = render(
    <ApprovePlan plan={plan} approve={(a) => (approved = a)} />,
  );
  yield* Effect.promise(waitUntilExit);
  return approved;
});

const displayPlan = <P extends IPlan>(plan: P): Effect.Effect<void> =>
  Effect.sync(() => {
    const { unmount } = render(<Plan plan={plan} />);
    unmount();
  });

const startApplySession = Effect.fn(function* <P extends IPlan>(plan: P) {
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
