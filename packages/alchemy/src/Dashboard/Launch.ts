import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";

import { AdoptPolicy } from "../AdoptPolicy.ts";
import { AlchemyContext } from "../AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "../Artifacts.ts";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import { withProfileOverride } from "../Auth/Profile.ts";
import * as Plan from "../Plan.ts";
import { Stage } from "../Stage.ts";
import * as State from "../State/index.ts";
import * as Clank from "../Util/Clank.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";
import { fileLogger } from "../Util/FileLogger.ts";
import { httpServer } from "../Util/PlatformServices.ts";
import * as Discovery from "./Discovery.ts";
import { toPlanJson, unavailablePlan, type DashboardPlan } from "./PlanJson.ts";
import * as Server from "./Server.ts";

/** The default export of a user's stack file, as loaded by `importStack`. */
export type ImportedStack = Effect.Success<
  ReturnType<typeof import("../Cli/commands/_shared.ts").importStack>
>;

export interface LaunchOptions {
  stackEffect: ImportedStack;
  stage: string;
  envFile: Option.Option<string>;
  profile: string;
  /** 0 picks a random free port */
  port: number;
  /** open the browser once serving */
  open: boolean;
  /** resolved once the server is up, with the dashboard URL */
  ready?: Deferred.Deferred<string>;
}

/**
 * Fail with install instructions when the dashboard UI (an optional peer
 * dependency) is not installed. Callers check this *before* doing any real
 * work so `--ui` fails fast rather than mid-deploy.
 */
export const requireDistDir = Effect.fn(function* () {
  const dist = yield* Server.resolveDistDir();
  if (dist !== undefined) {
    return dist;
  }
  yield* Console.error(
    [
      "The alchemy dashboard UI is not installed.",
      "",
      "It ships as a separate optional package so the core CLI stays lean:",
      "",
      "  bun add -D @alchemy.run/dashboard",
      "  # or: npm install --save-dev @alchemy.run/dashboard",
      "",
      "Then re-run this command.",
    ].join("\n"),
  );
  // The instructions above are the whole story — exit without the
  // runtime's failure/stack-trace dump. Nothing has been provisioned or
  // acquired at this point (callers check before doing any real work).
  return yield* Effect.sync(() => process.exit(1) as never);
});

/**
 * Launch the dashboard web app for a stack and serve until interrupted.
 *
 * Runs in the CLI's ambient context (platform services, AlchemyContext,
 * credentials). Used directly by `alchemy dashboard` and forked as a
 * background fiber by `deploy/destroy/plan --ui` — apply events reach it
 * through the DashboardReporter tee via Discovery, so the launcher needs
 * no coupling to the deploy itself.
 */
export const launchDashboard = Effect.fn(function* (options: LaunchOptions) {
  const { stackEffect, stage, envFile, profile, port, open, ready } = options;

  yield* requireDistDir();

  const configProvider = withProfileOverride(
    yield* loadConfigProvider(envFile),
    profile,
  );
  const authProviders = yield* Effect.serviceOption(AuthProviders).pipe(
    Effect.map(Option.getOrElse(() => ({}))),
  );
  // The CLI's ambient context captured once so per-stage plan evaluation
  // can be run from inside HTTP request handlers.
  const ambient = yield* Effect.context<never>();

  // Same service layers as `alchemy plan` (execStack with dryRun) so
  // Plan.make behaves identically to the CLI plan — parameterized by stage
  // so the dashboard can re-evaluate the stack for any stage.
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
   * Physical names, providers, and the compiled graph are functions of the
   * stage, so a stage switch is a full re-evaluation — this is what lets
   * the dashboard preview a stage that has never been deployed.
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
    ) as Effect.Effect<DashboardPlan>;

  yield* Effect.gen(function* () {
    const stack = yield* stackEffect;
    yield* Effect.gen(function* () {
      const state = yield* yield* State.State;

      const address = yield* Server.serve({
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
      if (ready !== undefined) {
        yield* Deferred.succeed(ready, url);
      }
      if (open) {
        yield* Clank.openUrl(url).pipe(Effect.catch(() => Effect.void));
      }
      yield* Effect.never;
    }).pipe(Effect.provide(stack.services), Effect.provide(httpServer(port)));
  }).pipe(Effect.provide(servicesFor(stage)), Effect.scoped);
});
