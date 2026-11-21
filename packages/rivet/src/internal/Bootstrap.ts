/**
 * Process bootstrap for a pool's nodes: build every Durable Object class the
 * node was bundled with, then host them all as RivetKit actors.
 *
 * @internal
 */
import { NodeServices } from "@effect/platform-node";
import { RuntimeConfigProviderLive } from "alchemy/Runtime";
import {
  entrypointLayer,
  entrypointTag,
  runProcess,
  stackFromEnv,
} from "alchemy/Runtime/Bootstrap";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import {
  DurableObjectHasNoPool,
  PlatformDeclaration,
  type DurableObjectRuntimeContext,
  type HostedDurableObject,
} from "../DurableObject.ts";
import { NodeHost } from "../Host.ts";
import { runDurableObjects } from "./Runtime.ts";
import { SECRET_ENV } from "./SecretEnv.ts";

/**
 * Secrets the node's classes read as config, handed over as one JSON value
 * by hosts that keep them in a secret store: set each as its own variable,
 * before any class reads its config.
 */
const loadSecretEnv = Effect.sync(() => {
  // oxlint-disable-next-line effecttsgo/process-env-in-effect -- the node's own env, written before any Config read
  const blob = process.env[SECRET_ENV];
  if (blob === undefined || blob === "") return;
  // oxlint-disable-next-line effecttsgo/process-env-in-effect -- see above
  delete process.env[SECRET_ENV];
  for (const [name, value] of Object.entries(JSON.parse(blob) as Record<string, string>)) {
    // oxlint-disable-next-line effecttsgo/process-env-in-effect -- see above
    process.env[name] = value;
  }
});

/** Build each entrypoint's class phase, then run the node until it is stopped. */
export const bootstrap = (entrypoints: ReadonlyArray<unknown>): Promise<void> => {
  const platform = Layer.mergeAll(
    // Node services run under both Node (Fly) and Bun (every other host).
    NodeServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  ).pipe(Layer.provideMerge(stackFromEnv), Layer.provideMerge(RuntimeConfigProviderLive));

  const program = Effect.gen(function* () {
    // Every class this node hosts: its exported ones, and those Layers host themselves.
    const hosted = yield* Ref.make<ReadonlyArray<HostedDurableObject>>([]);
    const host = (built: HostedDurableObject) =>
      Ref.update(hosted, (all) =>
        all.some((other) => other.name === built.name) ? all : [...all, built],
      );
    for (const entrypoint of entrypoints) {
      // A class's `yield*` is its namespace; the node builds its Platform.
      const declaration =
        (entrypoint as { [PlatformDeclaration]?: unknown } | undefined)?.[PlatformDeclaration] ??
        entrypoint;
      const context = yield* Layer.build(entrypointLayer(declaration)).pipe(
        Effect.provideService(NodeHost, NodeHost.of({ host, entrypoint })),
      );
      // A Layer that hosts its classes itself (a Domain model's) provides
      // none: it handed them to `NodeHost`.
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
      yield* host(built);
    }
    return yield* runDurableObjects(yield* Ref.get(hosted));
  }).pipe(Effect.provide(platform), Effect.scoped);

  // Before the platform's Layers read the environment.
  return runProcess("Rivet node", Effect.andThen(loadSecretEnv, program));
};
