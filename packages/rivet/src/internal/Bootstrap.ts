/**
 * Process bootstrap for a pool's nodes: build every Durable Object class the
 * node was bundled with, then host them all as RivetKit actors.
 *
 * @internal
 */
import { NodeServices } from "@effect/platform-node";
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
import * as Option from "effect/Option";
import {
  DurableObjectHasNoPool,
  PlatformDeclaration,
  type DurableObjectRuntimeContext,
} from "../DurableObject.ts";
import { NodeHost } from "./NodeHost.ts";
import { runDurableObjects } from "./Runtime.ts";

/** Build each entrypoint's class phase, then run the node until it is stopped. */
export const bootstrap = (entrypoints: ReadonlyArray<unknown>): Promise<void> => {
  const platform = Layer.mergeAll(
    // Node services run under both Node (Fly) and Bun (every other host).
    NodeServices.layer,
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
    NodeHost.active = true;
    for (const entrypoint of entrypoints) {
      // A class's `yield*` is its namespace; the node builds its Platform.
      const declaration =
        (entrypoint as { [PlatformDeclaration]?: unknown } | undefined)?.[PlatformDeclaration] ??
        entrypoint;
      const context = yield* Layer.build(entrypointLayer(declaration));
      // A Layer that hosts its classes itself (a Domain model's) provides
      // none: they are in `NodeHost.hosted`.
      const self = Context.getOption(context, entrypointTag);
      if (Option.isNone(self)) continue;
      const runtime = self.value.RuntimeContext as DurableObjectRuntimeContext;
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
    for (const built of NodeHost.hosted)
      if (!hosted.some((other) => other.name === built.name)) hosted.push(built);
    return yield* runDurableObjects(hosted);
  }).pipe(Effect.provide(platform), Effect.scoped);

  return runProcess("Rivet node", program);
};
