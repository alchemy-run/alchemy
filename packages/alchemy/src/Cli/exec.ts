import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { AlchemyContextLive } from "../AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "../Artifacts.ts";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import { makeDevLogOpener } from "../Local/DevLog.ts";
import * as RpcProviderProxy from "../Local/RpcProviderProxy.ts";
import { forwardSidecarLogs } from "../Local/RpcSpawner.ts";
import { TelemetryLive } from "../Telemetry/Layer.ts";
import { PlatformServices } from "../Util/PlatformServices.ts";
import * as Stacks from "../Alchemist/routes/stack.ts";
import { DevOptions } from "./DevOptions.ts";
import { ConsoleLogLive } from "./GlobalLog.ts";
import { handleCliErrors, installShutdownFeedback } from "./commands/errors.ts";
import { renderApply, renderPlanning } from "./commands/render.ts";
import * as CliKit from "./CliKit/index.ts";
import { selectCliServices } from "./selectCli.ts";

// Interactive dev/deploy runs use the Sigil progress UI; CI, redirected output,
// and other non-interactive terminals still select the append-only renderer.
// `ALCHEMY_TUI` remains the explicit override in either direction.
const services = Layer.mergeAll(
  Layer.provideMerge(
    Layer.mergeAll(selectCliServices(), CliKit.CliKitInteraction),
    CliKit.layer(),
  ),
  ConsoleLogLive,
  RpcProviderProxy.fromEnv(),
  Layer.succeed(ArtifactStore, createArtifactStore()),
  // Dev runs live in this exec child, not the `alchemy` CLI process, so
  // without this layer they'd export no telemetry at all. No root
  // `cli.dev` span though: dev parks in Effect.never until the watcher
  // kills the process, so a wrapping span would never end (and never
  // export) — plan/apply spans are the trace roots instead.
  TelemetryLive,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(AlchemyContextLive, ProfileStoreLive, CredentialsStoreLive),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      PlatformServices,
      FetchHttpClient.layer,
      ConfigProvider.layer(ConfigProvider.fromEnv()),
    ),
  ),
);

/** `alchemy dev` normally parks forever; set for single-pass runs (tests). */
const devOnce = Config.string("ALCHEMY_DEV_ONCE").pipe(
  Config.withDefault(""),
  Effect.map((value) => value === "1" || value === "true"),
);

const runDev = Effect.fn(function* (options: DevOptions) {
  const target = {
    entrypoint: options.main,
    stage: options.stage,
    profile: options.profile,
    envFile: Option.getOrUndefined(options.envFile),
  };
  const snapshot = yield* Stacks.plan({
    target,
    operation: "deploy",
    force: options.force,
    updateStateStore: true,
    dev: true,
    ingress: {
      domain: options.domain,
      port: options.port,
      relay: options.relay
        ? {
            url: options.relay,
            namespace:
              options.relayNamespace ??
              options.stage.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
            token: process.env.ALCHEMY_DEV_RELAY_TOKEN,
          }
        : undefined,
    },
  }).pipe(renderPlanning({ operation: "Dev", stage: options.stage }));
  const once = yield* devOnce;
  const applyPlan = Stacks.apply(snapshot).pipe(
    renderApply(snapshot.native, {
      stage: options.stage,
    }),
  );
  const result = yield* once
    ? applyPlan
    : applyPlan.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Console.error(
                `alchemy dev: apply failed; keeping dev alive so healthy resources keep serving.\n${Cause.pretty(cause)}`,
              ).pipe(Effect.as(undefined)),
        ),
      );
  if (result !== undefined) yield* Console.log(result);
  return once ? undefined : yield* Effect.never;
});

// A mid-edit import or planning failure must keep the watch process alive so
// the next save can restart it. Interruptions still propagate for Ctrl+C.
export const devKeepAlive = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Console.error(
            `alchemy dev: run failed; waiting for the next file change to retry.\n${Cause.pretty(cause)}`,
          ).pipe(Effect.andThen(Effect.never)),
    ),
  );

const makeExec = () => {
  const options = Schema.decodeSync(DevOptions)(
    JSON.parse(process.env.ALCHEMY_EXEC_OPTIONS!),
  );
  return Effect.gen(function* () {
    yield* installShutdownFeedback;
    // Subscribe to the spawner's sidecar log stream BEFORE the stack runs:
    // this process owns the terminal renderer, so sidecar output printed
    // here lands in chronological order with the run's own lines instead of
    // racing the shared tty. No-op outside dev. The mixed tail is also teed
    // to log/{stage}/{timestamp}.log; per-resource output lands in
    // log/{stage}/{fqn…}/ via the local providers.
    const devLog = yield* (yield* makeDevLogOpener)(options.stage);
    yield* forwardSidecarLogs((entry) =>
      devLog.writeLine(`[${entry.channel}] ${entry.line}`),
    );
    return yield* devKeepAlive(runDev(options));
  }).pipe(Effect.provide(services), Effect.scoped, handleCliErrors);
};

/** Fully wired sidecar CLI program. */
export const exec: () => Effect.Effect<
  void,
  Effect.Error<ReturnType<typeof makeExec>>
> = makeExec;
