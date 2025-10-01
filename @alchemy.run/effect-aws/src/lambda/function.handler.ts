import type { Statement } from "@alchemy.run/effect";
import type { Context as LambdaContext } from "aws-lambda";
import * as Effect from "effect/Effect";

type Handler = (
  event: any,
  context: LambdaContext,
) => Effect.Effect<any, any, never>;

type HandlerEffect<Req = Statement> = Effect.Effect<Handler, any, Req>;

const memo = Symbol.for("alchemy::memo");

// TODO(sam): is there a better way to lazily evaluate the Effect and cache the result?
const resolveHandler = async (
  effect: HandlerEffect & {
    [memo]?: Handler;
  },
) =>
  (effect[memo] ??= await Effect.runPromise(
    // safe to cast away the Statement requirements since they are phantoms
    effect as HandlerEffect<never>,
  ));

export const toHandler =
  (effect: Effect.Effect<Handler, any, Statement>) =>
  async (event: any, context: LambdaContext) =>
    (await resolveHandler(effect))(event, context);
