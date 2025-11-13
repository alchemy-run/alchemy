import type * as runtime from "@cloudflare/workers-types";
import type { Capability } from "alchemy-effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CloudflareContext } from "../context.ts";

type Handler = (
  request: Request,
  env: unknown,
  ctx: runtime.ExecutionContext,
) => Effect.Effect<Response, any, CloudflareContext>;
type HandlerFactory<H extends Handler, Req = Capability> = Effect.Effect<
  H,
  any,
  Req
>;

export const toHandler = <H extends Handler>(
  factory: HandlerFactory<H, Capability>,
) => {
  return {
    fetch: async (
      request: Request,
      env: unknown,
      ctx: runtime.ExecutionContext,
    ) => {
      const exit = await Effect.runPromiseExit(
        (factory as HandlerFactory<H, never>).pipe(
          Effect.flatMap((handler) => handler(request, env, ctx)),
          Effect.provide(Layer.succeed(CloudflareContext, { env, ctx })),
        ),
      );
      if (exit._tag === "Success") {
        return exit.value;
      }
      return Response.json(exit, { status: 500 });
    },
  };
};
