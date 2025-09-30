import type { Resource, Statement } from "@alchemy.run/effect";
import type { Context as LambdaContext } from "aws-lambda";
import * as Effect from "effect/Effect";

const memo = Symbol.for("alchemy::memo");
// TODO(sam): is there a better way to lazily evaluate the Effect and cache the result?
const resolveHandler = async (
  effect: Effect.Effect<Resource, any, Statement> & {
    [memo]?: Resource;
  },
) =>
  (effect[memo] ??= await Effect.runPromise(
    effect as Effect.Effect<Resource, any, never>,
  ));

export const toHandler =
  (effect: Effect.Effect<Resource, any, Statement>) =>
  async (event: any, context: LambdaContext) =>
    (await resolveHandler(effect))(event, context);
