import * as Effect from "effect/Effect";
import { GcpEnvironment } from "../Environment.ts";

/**
 * Run a provider's `lookup` in the project its props name, else the
 * ambient one. Pass it as the `Effect.fn` pipeable of a `lookup` so every
 * `GcpEnvironment.current` inside the body (and inside the helpers it
 * calls) sees the looked-up project.
 */
export const inLookupProject = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  { project }: { readonly project?: string | undefined },
): Effect.Effect<A, E, R | GcpEnvironment> =>
  project === undefined
    ? effect
    : Effect.updateService(effect, GcpEnvironment, (env) =>
        Effect.map(env, (current) => ({ ...current, project })),
      );
