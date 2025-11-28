// biome-ignore lint/correctness/noUnusedImports: UMD global
import React from "react";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { render } from "ink";

import { PlanRejected, PlanReviewer } from "../approve.ts";
import type { IPlan } from "../plan.ts";
import { ApprovePlan } from "./components/ApprovePlan.tsx";

export const requireApproval = Layer.succeed(
  PlanReviewer,
  PlanReviewer.of({
    approve: <P extends IPlan>(plan: P) =>
      Effect.gen(function* () {
        let approved = false;

        const { waitUntilExit } = render(
          <ApprovePlan plan={plan} approve={(a) => (approved = a)} />,
        );

        yield* Effect.promise(() => waitUntilExit());

        if (!approved) {
          yield* Effect.fail(new PlanRejected());
        }
      }),
  }),
);
