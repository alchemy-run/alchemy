// biome-ignore lint/correctness/noUnusedImports: UMD global
import React from "react";

import * as Effect from "effect/Effect";

import { render } from "ink";

import type { IPlan } from "../plan.ts";
import { Plan } from "./components/Plan.tsx";

/**
 * Displays the plan to the terminal and immediately returns.
 */
export const displayPlan = <P extends IPlan>(plan: P): Effect.Effect<void> =>
  Effect.sync(() => {
    const { unmount } = render(<Plan plan={plan} />);
    unmount();
  });
