/**
 * Process bootstrap for a pool's nodes: build every Durable Object class the
 * node was bundled with, then host them all as RivetKit actors.
 *
 * @internal
 */
import { BunServices } from "@effect/platform-bun";
import { reifyBoundConfigProvider } from "alchemy/Runtime";
import {
  entrypointLayer,
  entrypointTag,
  runProcess,
  stackFromEnv,
} from "alchemy/Runtime/Bootstrap";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { DurableObjectHasNoPool, type DurableObjectRuntimeContext } from "../DurableObject.ts";
import { runDurableObjects } from "./Runtime.ts";

/** Build each entrypoint's class phase, then run the node until it is stopped. */
export const bootstrap = (entrypoints: ReadonlyArray<unknown>): Promise<void> => {
  const platform = Layer.mergeAll(
    BunServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  ).pipe(
    Layer.provideMerge(stackFromEnv),
    Layer.provideMerge(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env),
      ),
    ),
  );

  const program = Effect.gen(function* () {
    const hosted = [];
    for (const entrypoint of entrypoints) {
      const context = yield* Layer.build(entrypointLayer(entrypoint));
      const runtime = Context.get(context, entrypointTag)
        .RuntimeContext as DurableObjectRuntimeContext;
      const built = runtime.hosted();
      if (built === undefined) {
        return yield* Effect.die(
          new DurableObjectHasNoPool({
            message: `Rivet.DurableObject '${runtime.id}' did not finish its class phase.`,
          }),
        );
      }
      hosted.push(built);
    }
    return yield* runDurableObjects(hosted);
  }).pipe(Effect.provide(platform), Effect.scoped);

  return runProcess("Rivet node", program);
};
