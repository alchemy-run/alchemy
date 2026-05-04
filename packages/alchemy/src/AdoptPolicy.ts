import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export class AdoptPolicy extends Context.Service<AdoptPolicy, boolean>()(
  "AdoptPolicy",
) {}

export const adopt: {
  (
    enabled?: boolean,
  ): <A, E, R = never>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  <R1 = never>(
    enabled: Effect.Effect<boolean, never, R1>,
  ): <A, E, R2 = never>(
    effect: Effect.Effect<A, E, R2>,
  ) => Effect.Effect<A, E, R1 | R2>;
} = ((enabled: boolean | Effect.Effect<boolean, never, any>) =>
  (eff: Effect.Effect<any, any, any>) =>
    eff.pipe(
      typeof enabled === "boolean"
        ? Effect.provideService(AdoptPolicy, enabled ?? true)
        : Effect.provideServiceEffect(AdoptPolicy, enabled),
    )) as any;
