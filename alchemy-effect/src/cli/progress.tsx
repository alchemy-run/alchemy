// biome-ignore lint/correctness/noUnusedImports: UMD global
import React from "react";

import { render } from "ink";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PlanStatusReporter } from "../apply.ts";
import type { ApplyEvent } from "../event.ts";
import { PlanProgress } from "./components/PlanProgress.tsx";

export interface ProgressEventSource {
  subscribe(listener: (event: ApplyEvent) => void): () => void;
}

export const reportProgress = Layer.succeed(
  PlanStatusReporter,
  PlanStatusReporter.of({
    // oxlint-disable-next-line require-yield
    start: Effect.fn(function* (plan) {
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
        done: () =>
          Effect.gen(function* () {
            yield* Effect.sleep(10); // give the react event loop time to re-render
            yield* Effect.sync(() => unmount());
          }),
        emit: (event) =>
          Effect.sync(() => {
            for (const listener of listeners) listener(event);
          }),
      };
    }),
  }),
);
