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
import * as Discovery from "../../Dashboard/Discovery.ts";
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

      const configProvider = withProfileOverride(
        yield* loadConfigProvider(envFile),
        profile,
      );
      const authProviders = yield* Effect.serviceOption(AuthProviders).pipe(
        Effect.map(Option.getOrElse(() => ({}))),
      );
      // The CLI's ambient context (platform services, base AlchemyContext,
      // credentials, ...) captured once so per-stage plan evaluation can be
      // run from inside HTTP request handlers.
      const ambient = yield* Effect.context<never>();

      // Same service layers as `alchemy plan` (execStack with dryRun) so
      // Plan.make behaves identically to the CLI plan — parameterized by
      // stage so the dashboard can re-evaluate the stack for any stage.
      const servicesFor = (stg: string) =>
        Layer.mergeAll(
          Layer.effect(
            AlchemyContext,
            AlchemyContext.pipe(
              Effect.map((ctx) => ({ ...ctx, dev: false, adopt: false })),
            ),
          ),
          Layer.succeed(AdoptPolicy, false),
          Layer.succeed(ArtifactStore, createArtifactStore()),
          Layer.succeed(AuthProviders, authProviders),
          ConfigProvider.layer(configProvider),
          Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
          Layer.succeed(Stage, stg),
        );

      /**
       * Re-run the user's stack effect under `Stage = stg` and plan it.
       * Physical names, providers, and the compiled graph are functions of
       * the stage, so a stage switch is a full re-evaluation — this is what
       * lets the dashboard preview a stage that has never been deployed.
       */
      const planForStage = (stg: string) =>
        Effect.gen(function* () {
          const stk = yield* stackEffect;
          return yield* Plan.make(stk, { force: false }).pipe(
            Effect.map(toPlanJson),
            Effect.provide(stk.services),
          );
        }).pipe(
          Effect.provide(servicesFor(stg)),
          Effect.catchCause((cause) =>
            Effect.succeed(unavailablePlan(Cause.pretty(cause))),
          ),
          // ambient is Context<never> type-wise but carries the CLI's full
          // service map at runtime; the remaining requirements are all
          // satisfied from it.
          Effect.provideContext(ambient),
        ) as Effect.Effect<import("../../Dashboard/PlanJson.ts").DashboardPlan>;

      yield* Effect.gen(function* () {
        const stack = yield* stackEffect;
        yield* Effect.gen(function* () {
          const state = yield* yield* State.State;

          const address = yield* Dashboard.serve({
            state,
            stack: stackEffect.stackName,
            stage,
            plan: planForStage,
          });

          const url = address.replace("0.0.0.0", "127.0.0.1");
          // advertise so deploys in this project stream apply events here
          yield* Discovery.advertise({
            url,
            stack: stackEffect.stackName,
            stage,
          });
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
      }).pipe(Effect.provide(servicesFor(stage)), Effect.scoped);
    }),
  ),
);
