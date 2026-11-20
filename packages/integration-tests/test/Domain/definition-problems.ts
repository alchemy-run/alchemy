import { InMemory } from "@alchemy.run/domain/InMemory";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

/**
 * Build a model's Layer in memory and return what it died with: one
 * `Domain.DefinitionError` per definition problem, in definition order.
 * Empty when the Layer builds.
 */
export const definitionProblems = <A, E>(
  layer: Layer.Layer<A, E, Layer.Success<typeof InMemory>>,
): Effect.Effect<ReadonlyArray<unknown>> =>
  Layer.build(layer).pipe(
    Effect.scoped,
    Effect.provide(InMemory),
    Effect.exit,
    Effect.map((exit) =>
      Exit.isSuccess(exit)
        ? []
        : exit.cause.reasons.map((reason) => (Cause.isDieReason(reason) ? reason.defect : reason)),
    ),
  );
