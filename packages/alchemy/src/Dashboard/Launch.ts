import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";

import { AdoptPolicy } from "../AdoptPolicy.ts";
import { AlchemyContext } from "../AlchemyContext.ts";
import type { StackModule } from "../Alchemist/Session.ts";
import { ArtifactStore, createArtifactStore } from "../Artifacts.ts";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import { withProfileOverride } from "../Auth/Resolve.ts";
import { openUrl } from "../Interaction.ts";
import * as Plan from "../Plan.ts";
import { Stage } from "../Stage.ts";
import * as State from "../State/index.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";
import { fileLogger } from "../Util/FileLogger.ts";
import { httpServer } from "../Util/PlatformServices.ts";
import * as Discovery from "./Discovery.ts";
import type { StackStructure } from "./Document.ts";
import { toPlanJson, unavailablePlan, type DashboardPlan } from "./PlanJson.ts";
import * as Server from "./Server.ts";

export interface LaunchOptions {
  /** The user's stack module, as loaded by `Alchemist.importStack`. */
  stackEffect: StackModule;
  stage: string;
  envFile: Option.Option<string>;
  profile: string | undefined;
  /** 0 picks a random free port */
  port: number;
  /** open the browser once serving */
  open: boolean;
  /** resolved once the server is up, with the dashboard URL */
  ready?: Deferred.Deferred<string>;
  /** the CLI command this run-scoped dashboard serves (see Server options) */
  command?: "deploy" | "destroy" | "plan";
}

/**
 * Fail with install instructions when the dashboard UI (an optional peer
 * dependency) is not installed. Callers check this *before* doing any real
 * work so a `--ui` run fails fast rather than mid-deploy.
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
 * Ask the dashboard's user to approve a plan (a `--ui` run without `--yes`).
 *
 * Sends the plan to the dashboard and polls for the browser's decision.
 * Interruption (Ctrl-C) propagates normally; a failure to reach the
 * dashboard resolves to `undefined` so the caller can fall back to the
 * terminal prompt rather than silently rejecting.
 */
export const requestApprovalViaDashboard = Effect.fn(function* (
  dashboardUrl: string,
  plan: Parameters<typeof toPlanJson>[0],
) {
  const id = `approval-${process.pid}-${Date.now().toString(36)}`;
  // Generous timeout + retries: the dashboard evaluates plans in-process
  // (single-threaded Bun), so a bundling run can hold the event loop for
  // seconds — a short abort here would silently drop to the terminal
  // fallback, which auto-approves without a TTY.
  const post = Effect.tryPromise(() =>
    fetch(`${dashboardUrl}/api/approval/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, plan: toPlanJson(plan) }),
      signal: AbortSignal.timeout(15_000),
    }),
  ).pipe(
    Effect.retry({ times: 2, schedule: Schedule.spaced("1 second") }),
    Effect.orElseSucceed(() => undefined),
  );
  if ((yield* post) === undefined) {
    return undefined;
  }

  const poll = Effect.tryPromise(async () => {
    const res = await fetch(
      `${dashboardUrl}/api/approval/status?id=${encodeURIComponent(id)}`,
      { signal: AbortSignal.timeout(3000) },
    );
    const body = (await res.json()) as { approved: boolean | null };
    return body.approved;
  }).pipe(Effect.orElseSucceed(() => null));

  // wait indefinitely for the human; Ctrl-C interrupts the whole run
  return yield* poll.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("500 millis"),
      until: (decision): decision is boolean => decision !== null,
    }),
  );
});

/**
 * Launch the dashboard web app for a stack and serve until interrupted.
 *
 * Runs in the CLI's ambient context (platform services, AlchemyContext,
 * credentials). Meant to be run directly by a `dashboard` command or forked
 * as a background fiber by a `--ui` deploy/destroy/plan — apply events
 * reach it through the reporter tee via Discovery, so the launcher needs no
 * coupling to the deploy itself.
 */
export const launchDashboard = Effect.fn(function* (options: LaunchOptions) {
  const { stackEffect, stage, envFile, profile, port, open, ready, command } =
    options;

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

  // Same service layers as a plan-only run so Plan.make behaves identically
  // to the CLI plan — parameterized by stage so the dashboard can
  // re-evaluate the stack for any stage.
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

  /**
   * The stack's SHAPE only: evaluate the stack file (register resources +
   * bindings) without planning — no cloud calls, so it completes in
   * seconds and works without credentials. Feeds the canvas's "defined
   * but not deployed" ghosts.
   */
  const structureForStage = (stg: string) =>
    Effect.gen(function* () {
      const stk = yield* stackEffect;
      const resources = Object.entries(stk.resources).map(([fqn, r]) => ({
        fqn,
        logicalId: r.LogicalId,
        type: r.Type,
        bindingSids: (stk.bindings[fqn] ?? [])
          .map((b) => b.sid)
          .filter((sid): sid is string => typeof sid === "string"),
      }));
      // Actions (tasks) are deliberately NOT part of the ghost shape: a
      // task exists in the graph only when it RAN (persisted state feeds
      // the baseline) or WILL run (the plan overlay synthesizes a "run"
      // node). A "defined but not deployed" ghost is meaningless for
      // something that has no cloud presence — and after a destroy, the
      // task must not resurface at all. Node positions survive its
      // exit/return via the per-node position memory.
      return { resources } satisfies StackStructure;
    }).pipe(
      Effect.provide(servicesFor(stg)),
      Effect.catchCause(() =>
        Effect.succeed({ resources: [] } satisfies StackStructure),
      ),
      Effect.provideContext(ambient),
    ) as Effect.Effect<StackStructure>;

  yield* Effect.gen(function* () {
    const stack = yield* stackEffect;

    // The HTTP layer is built in a scope WE close on a DETACHED fiber:
    // its finalizer awaits Bun's graceful `server.stop()`, which waits on
    // the browser's idle keep-alive connections and can pend forever.
    // Closing it inline (via Effect.provide's own scope) blocks the whole
    // CLI's teardown — the deploy would hang after "dashboard stopped".
    // The detached close does its best; runMain's process.exit reaps any
    // lingering server handle.
    const serverScope = yield* Scope.make();
    const serverContext = yield* Layer.buildWithScope(
      // plan evaluation can hold a request open for a long time — give it
      // headroom past Bun's 10s default idle timeout
      httpServer(port, "127.0.0.1", {
        idleTimeout: 240,
        gracefulShutdownTimeout: "2 seconds",
      }),
      serverScope,
    );
    const closeServer = Effect.forkDetach(
      Scope.close(serverScope, Exit.void),
    ).pipe(Effect.asVoid);

    const exit = yield* Effect.gen(function* () {
      const state = yield* yield* State.State;

      const address = yield* Server.serve({
        state,
        stack: stackEffect.stackName,
        stage,
        plan: planForStage,
        structure: structureForStage,
        command,
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
        // Always open: the SPA's same-origin BroadcastChannel takeover
        // closes any older dashboard tab when the new one loads, so this
        // both focuses the browser (natively, no automation) and keeps
        // exactly one tab alive.
        yield* openUrl(url).pipe(Effect.catch(() => Effect.void));
      }
      yield* Effect.never;
    }).pipe(
      // Scope the server region SO ITS OWN scope (holding the SSE latch
      // and the serve finalizer) closes before the server itself is torn
      // down — live streams end cleanly first.
      Effect.scoped,
      Effect.provide(stack.services),
      Effect.provideContext(serverContext),
      Effect.exit,
      // runs on interruption too (Ctrl+C): kick the detached close so the
      // server never blocks the CLI's teardown
      Effect.ensuring(closeServer),
    );
    // A teardown interrupt (the graceful-stop cap interrupting the cached
    // shutdown effect) is an artifact, not an error — re-raise only real
    // causes.
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      return yield* Effect.failCause(exit.cause);
    }
  }).pipe(Effect.provide(servicesFor(stage)), Effect.scoped);
});
