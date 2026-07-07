import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

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
import type { StackStructure } from "./Scene.ts";
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
 * Ask the dashboard's user to approve a plan (`--ui` without `--yes`).
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
  while (true) {
    const decision = yield* poll;
    if (decision !== null) {
      return decision;
    }
    yield* Effect.sleep("500 millis");
  }
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

  /**
   * The stack's SHAPE only: evaluate the stack file (register resources +
   * bindings) without planning — no cloud calls, so it completes in
   * seconds and works without credentials. Feeds the canvas's "defined
   * but not deployed" ghosts.
   */
  const structureForStage = (stg: string) =>
    Effect.gen(function* () {
      const stk = yield* stackEffect;
      const resources = Object.entries(
        stk.resources as Record<string, { LogicalId: string; Type: string }>,
      ).map(([fqn, r]) => ({
        fqn,
        logicalId: r.LogicalId,
        type: r.Type,
        bindingSids: (
          ((stk.bindings as Record<string, { sid: unknown }[]>)[fqn] ?? []) as {
            sid: unknown;
          }[]
        )
          .map((b) => b.sid)
          .filter((sid): sid is string => typeof sid === "string"),
      }));
      // actions (tasks) are part of the stack's shape too — without them
      // the post-destroy ghost graph is missing nodes (and the structural
      // hash shifts, forcing a relayout)
      const actions = Object.entries(
        (stk.actions ?? {}) as Record<
          string,
          { LogicalId?: string; Type?: string }
        >,
      ).map(([fqn, a]) => ({
        fqn,
        logicalId: a.LogicalId ?? fqn.split("/").at(-1) ?? fqn,
        type: a.Type ?? "Action",
        bindingSids: [],
        kind: "action" as const,
      }));
      return { resources: [...resources, ...actions] } satisfies StackStructure;
    }).pipe(
      Effect.provide(servicesFor(stg)),
      Effect.catchCause(() =>
        Effect.succeed({ resources: [] } satisfies StackStructure),
      ),
      Effect.provideContext(ambient),
    ) as Effect.Effect<StackStructure>;

  yield* Effect.gen(function* () {
    const stack = yield* stackEffect;
    yield* Effect.gen(function* () {
      const state = yield* yield* State.State;

      // Signals when any SSE client attaches — a previous dashboard tab
      // auto-reconnects to the restarted server (the SPA retries with
      // backoff), in which case opening ANOTHER tab is just clutter.
      const clientConnected = yield* Deferred.make<void>();

      const address = yield* Server.serve({
        state,
        stack: stackEffect.stackName,
        stage,
        plan: planForStage,
        structure: structureForStage,
        onClientConnected: Deferred.succeed(clientConnected, void 0).pipe(
          Effect.asVoid,
        ),
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
        // Give a previously-open tab a moment to reconnect before opening
        // a new one — the browser can't be asked to reuse a tab from the
        // CLI, but a reconnected tab makes opening one unnecessary. A
        // shutdown breadcrumb from a previous run means a tab very likely
        // still exists and is polling (the SPA retries every ≤4s against
        // the same stable port), so wait past a full retry interval.
        const breadcrumb = yield* Discovery.lastAdvertised().pipe(
          Effect.orElseSucceed(() => undefined),
        );
        const reconnected = yield* Deferred.await(clientConnected).pipe(
          Effect.timeout(
            breadcrumb?.stack === stackEffect.stackName
              ? "6 seconds"
              : "2500 millis",
          ),
          Effect.result,
        );
        if (Result.isSuccess(reconnected)) {
          yield* Console.log("  (existing dashboard tab reconnected)");
          // raise the reconnected tab (best-effort, forked so a macOS
          // automation-permission prompt can never stall the run)
          yield* Effect.forkScoped(
            Clank.focusUrl(url).pipe(Effect.catch(() => Effect.succeed(false))),
          );
        } else {
          yield* Clank.openUrl(url).pipe(Effect.catch(() => Effect.void));
        }
      }
      yield* Effect.never;
    }).pipe(
      // Scope the server region SO ITS OWN scope (holding the SSE request
      // fibers and the serve finalizer) closes before the HTTP layer below
      // unwinds. Without this the layer's finalizer (Bun's graceful
      // `server.stop()`, which waits for in-flight connections) deadlocks
      // against SSE streams that only die when the outer scope closes —
      // and the outer scope is blocked behind that very finalizer.
      Effect.scoped,
      Effect.provide(stack.services),
      // plan evaluation can hold a request open for a long time — give it
      // headroom past Bun's 10s default idle timeout
      Effect.provide(
        httpServer(port, "127.0.0.1", {
          idleTimeout: 240,
          gracefulShutdownTimeout: "2 seconds",
        }),
      ),
    );
  }).pipe(Effect.provide(servicesFor(stage)), Effect.scoped);
});
