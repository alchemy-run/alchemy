import type { Context as LambdaContext } from "aws-lambda";
import * as Effect from "effect/Effect";
import type { Capability } from "../../capability.ts";

type Handler = (
  event: any,
  context: LambdaContext,
) => Effect.Effect<any, any, never>;

type HandlerEffect<Req = Capability> = Effect.Effect<Handler, any, Req>;

const memo = Symbol.for("alchemy::memo");

// TODO(sam): is there a better way to lazily evaluate the Effect and cache the result?
const resolveHandler = async (
  effect: HandlerEffect & {
    [memo]?: Handler;
  },
) =>
  (effect[memo] ??= await Effect.runPromise(
    // safe to cast away the Capability requirements since they are phantoms
    effect as HandlerEffect<never>,
  ));

export const toHandler =
  <H extends Handler>(effect: Effect.Effect<H, any, Capability>) =>
  async (event: any, context: LambdaContext) =>
    Effect.runPromise(
      (await resolveHandler(effect))(event, context),
    ) as Promise<Effect.Effect.Success<ReturnType<H>>>;
