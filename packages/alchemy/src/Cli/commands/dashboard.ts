import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

import { AdoptPolicy } from "../../AdoptPolicy.ts";
import { AlchemyContext } from "../../AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "../../Artifacts.ts";
import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Profile.ts";
import { toPlanJson, unavailablePlan } from "../../Dashboard/PlanJson.ts";
import * as Dashboard from "../../Dashboard/Server.ts";
import * as Plan from "../../Plan.ts";
import { Stage } from "../../Stage.ts";
import * as State from "../../State/index.ts";
import * as Clank from "../../Util/Clank.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";
import { httpServer } from "../../Util/PlatformServices.ts";

import {
  envFile,
  importStack,
  instrumentCommand,
  profile,
  script,
  stage,
} from "./_shared.ts";

const port = Flag.integer("port").pipe(
  Flag.withDescription("Port to serve the dashboard on"),
  Flag.withDefault(4444),
);

const noOpen = Flag.boolean("no-open").pipe(
  Flag.withDescription("Do not open the dashboard in the browser"),
  Flag.withDefault(false),
);

/**
 * `alchemy dashboard [main]` — serve a local web dashboard visualizing the
 * stack's resource graph from the state store, annotated with the current
 * plan (create/update/replace/delete) when it can be computed.
 *
 * The stack file is imported and evaluated with the same layers `alchemy
 * plan` uses, so `/api/plan` reflects exactly what a deploy would do. If
 * plan computation fails (e.g. missing credentials), the dashboard
 * degrades to the state-only view.
 */
export const dashboardCommand = Command.make(
  "dashboard",
  {
    main: script,
    stage,
    envFile,
    profile,
    port,
    noOpen,
  },
  instrumentCommand(
    "dashboard",
    (a: { main: string; stage: string; port: number }) => ({
      "alchemy.main": a.main,
      "alchemy.stage": a.stage,
      "alchemy.dashboard.port": a.port,
    }),
  )(
    Effect.fn(function* ({ main, stage, envFile, profile, port, noOpen }) {
      const stackEffect = yield* importStack(main);

      // Same service layers as `alchemy plan` (execStack with dryRun) so
      // Plan.make behaves identically to the CLI plan.
      const services = Layer.mergeAll(
        Layer.effect(
          AlchemyContext,
          AlchemyContext.pipe(
            Effect.map((ctx) => ({ ...ctx, dev: false, adopt: false })),
          ),
        ),
        Layer.succeed(AdoptPolicy, false),
        Layer.succeed(ArtifactStore, createArtifactStore()),
        Layer.succeed(
          AuthProviders,
          yield* Effect.serviceOption(AuthProviders).pipe(
            Effect.map(Option.getOrElse(() => ({}))),
          ),
        ),
        ConfigProvider.layer(
          withProfileOverride(yield* loadConfigProvider(envFile), profile),
        ),
        Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
        Layer.succeed(Stage, stage),
      );

      yield* Effect.gen(function* () {
        const stack = yield* stackEffect;
        yield* Effect.gen(function* () {
          const state = yield* yield* State.State;

          // Provided with the current context, so the server can run it
          // per-request without re-threading services.
          const computePlan = Effect.gen(function* () {
            const plan = yield* Plan.make(stack, { force: false });
            return toPlanJson(plan);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.succeed(unavailablePlan(Cause.pretty(cause))),
            ),
            Effect.provideContext(yield* Effect.context<State.State>()),
          );

          const address = yield* Dashboard.serve({
            state,
            stack: stackEffect.stackName,
            stage,
            plan: computePlan,
          });

          const url = address.replace("0.0.0.0", "127.0.0.1");
          yield* Console.log(
            `alchemy dashboard for ${stackEffect.stackName}/${stage}`,
          );
          yield* Console.log(`  ${url}`);
          if (!noOpen) {
            yield* Clank.openUrl(url).pipe(Effect.catch(() => Effect.void));
          }
          yield* Effect.never;
        }).pipe(
          Effect.provide(stack.services),
          Effect.provide(httpServer(port)),
        );
      }).pipe(Effect.provide(services), Effect.scoped);
    }),
  ),
);
