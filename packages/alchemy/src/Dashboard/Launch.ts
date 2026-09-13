import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";

import { open, type StackTarget } from "../Alchemist/Session.ts";
import { openUrl } from "../Interaction.ts";
import * as Plan from "../Plan.ts";
import * as State from "../State/index.ts";
import { httpServer } from "../Util/PlatformServices.ts";
import * as Discovery from "./Discovery.ts";
import { requireDistDir } from "./Dist.ts";
import type { StackStructure } from "./Document.ts";
import { toPlanJson, unavailablePlan, type DashboardPlan } from "./PlanJson.ts";
import * as Server from "./Server.ts";

export { DashboardNotInstalled, requireDistDir } from "./Dist.ts";

/** Everything opening a stack session needs — captured once by the launcher. */
type SessionServices = Effect.Services<ReturnType<typeof open>>;

/** The CLI command a run-scoped dashboard serves (see `Server.ts`). */
export type DashboardCommand = "deploy" | "destroy" | "plan";

export interface LaunchOptions {
  /**
   * The stack the dashboard serves: entrypoint, stage, profile and env
   * file — the same {@link StackTarget} every Alchemist route takes, so
   * the dashboard evaluates the user's program exactly like `plan` does.
   */
  target: StackTarget;
  /** 0 picks a random free port */
  port: number;
  /** open the browser once serving */
  open: boolean;
  /** resolved once the server is up, with the dashboard URL */
  ready?: Deferred.Deferred<string>;
  /** the CLI command this run-scoped dashboard serves (see Server options) */
  command?: DashboardCommand;
}

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
  plan: Plan.Plan,
) {
  const now = yield* Clock.currentTimeMillis;
  const id = `approval-${process.pid}-${now.toString(36)}`;
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
 * credentials, the route cache). Meant to be run directly by the
 * `dashboard` command or forked as a background fiber by a `--ui`
 * deploy/destroy/plan — apply events reach it through the reporter tee via
 * Discovery, so the launcher needs no coupling to the deploy itself.
 *
 * Stack sessions come from {@link open}: the dashboard's own stage is
 * opened up front (it owns the state store the server reads), and every
 * other stage the browser asks for is opened on demand — physical names,
 * providers and the compiled graph are functions of the stage, so a stage
 * switch is a full re-evaluation, which is what lets the dashboard preview
 * a stage that has never been deployed.
 */
export const launchDashboard = Effect.fn(function* (options: LaunchOptions) {
  const { target, port, open: openBrowser, ready, command } = options;

  yield* requireDistDir();

  const session = yield* open(target);
  const stackName = session.stack.name;

  // The launcher's ambient context (services AND its long-lived Scope)
  // captured once so per-stage sessions opened from inside HTTP request
  // handlers outlive the request instead of dying with its scope.
  const ambient = yield* Effect.context<SessionServices | Scope.Scope>();

  const sessionFor = (stage: string) =>
    stage === target.stage
      ? Effect.succeed(session)
      : open({ ...target, stage }).pipe(Effect.provideContext(ambient));

  /**
   * Re-run the user's stack under `stage` and plan it. Failures are
   * expected (missing credentials, a broken stack file) and surface as an
   * unavailable plan rather than an error.
   */
  const planForStage = (stage: string): Effect.Effect<DashboardPlan> =>
    Effect.gen(function* () {
      const stg = yield* sessionFor(stage);
      return yield* Plan.make(stg.stack, { force: false }).pipe(
        Effect.map(toPlanJson),
        Effect.provide(stg.context),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed(unavailablePlan(Cause.pretty(cause))),
      ),
      Effect.provideContext(ambient),
    );

  /**
   * The stack's SHAPE only: evaluate the stack file (register resources +
   * bindings) without planning — no cloud calls, so it completes in
   * seconds and works without credentials. Feeds the canvas's "defined
   * but not deployed" ghosts.
   */
  const structureForStage = (stage: string): Effect.Effect<StackStructure> =>
    sessionFor(stage).pipe(
      Effect.map(({ stack }) => {
        const resources = Object.entries(stack.resources).map(([fqn, r]) => ({
          fqn,
          logicalId: r.LogicalId,
          type: r.Type,
          bindingSids: (stack.bindings[fqn] ?? [])
            .map((b) => b.sid)
            .filter((sid): sid is string => typeof sid === "string"),
        }));
        // Actions (tasks) are deliberately NOT part of the ghost shape: a
        // task exists in the graph only when it RAN (persisted state feeds
        // the baseline) or WILL run (the plan overlay synthesizes a "run"
        // node). A "defined but not deployed" ghost is meaningless for
        // something that has no cloud presence — and after a destroy, the
        // task must not resurface at all.
        return { resources } satisfies StackStructure;
      }),
      Effect.catchCause(() =>
        Effect.succeed({ resources: [] } satisfies StackStructure),
      ),
      Effect.provideContext(ambient),
    );

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
      stack: stackName,
      stage: target.stage,
      plan: planForStage,
      structure: structureForStage,
      command,
    });

    const url = address.replace("0.0.0.0", "127.0.0.1");
    // advertise so deploys in this project stream apply events here
    yield* Discovery.advertise({
      url,
      stack: stackName,
      stage: target.stage,
    });
    yield* Console.log(`alchemy dashboard for ${stackName}/${target.stage}`);
    yield* Console.log(`  ${url}`);
    if (ready !== undefined) {
      yield* Deferred.succeed(ready, url);
    }
    if (openBrowser) {
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
    Effect.provide(session.context),
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
});

export interface EnsureOptions {
  target: StackTarget;
  /** the stack's name — needed before a server exists to pick its port */
  stackName: string;
  command?: DashboardCommand;
  /** open the browser on the (new or reused) dashboard */
  open: boolean;
}

export interface EnsuredDashboard {
  url: string;
  /**
   * `true` when THIS process started the server (so it is the one that
   * must stop it); `false` when an already-running dashboard for the
   * project was reused.
   */
  launched: boolean;
  /** the background server fiber, when launched here */
  fiber?: Fiber.Fiber<void, never>;
}

/**
 * Bring a dashboard up for a `--ui` run: reuse an already-running
 * `alchemy dashboard` for this project when one is advertised (or still
 * serving on the project's stable port after its advertisement was lost),
 * otherwise launch one in-process as a background fiber on the stable port
 * — deterministic from cwd + stack, so the previous run's browser tab
 * reconnects to the same origin. Falls back to a random port when
 * something foreign owns the stable one.
 *
 * Resolves to `undefined` when the server could not be started in time;
 * callers then continue without the dashboard.
 */
export const ensureDashboard = Effect.fn(function* (options: EnsureOptions) {
  const { target, stackName, command, open: openBrowser } = options;
  const reuse = (url: string) =>
    Effect.gen(function* () {
      if (openBrowser) {
        yield* openUrl(url).pipe(Effect.catch(() => Effect.void));
      }
      return { url, launched: false } satisfies EnsuredDashboard;
    });

  const existing = yield* Discovery.discover().pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (existing !== undefined) {
    return yield* reuse(existing.url);
  }
  let port = Discovery.stablePort(stackName);
  const probe = yield* Discovery.probePort(port, stackName);
  if (probe.kind === "ours") {
    return yield* reuse(probe.url);
  }
  if (probe.kind === "foreign") {
    port = 0;
  }
  const ready = yield* Deferred.make<string>();
  const fiber = yield* Effect.forkScoped(
    launchDashboard({
      target,
      port,
      open: openBrowser,
      ready,
      command,
    }).pipe(
      Effect.catchCause((cause) =>
        Console.error(`dashboard failed:\n${Cause.pretty(cause)}`),
      ),
    ),
  );
  const url = yield* Deferred.await(ready).pipe(
    Effect.timeout(Duration.seconds(30)),
    Effect.orElseSucceed(() => undefined),
  );
  if (url === undefined) {
    yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
    return undefined;
  }
  return { url, launched: true, fiber } satisfies EnsuredDashboard;
});

/**
 * Stop a dashboard this process launched: give the SSE stream a beat to
 * flush the final patch frames, then interrupt the server fiber so its
 * finalizers run (advertisement cleanup, SSE latch). Bounded — the server
 * must never hold the CLI's exit hostage.
 */
export const stopDashboard = Effect.fn(function* (dashboard: EnsuredDashboard) {
  if (!dashboard.launched || dashboard.fiber === undefined) {
    return;
  }
  yield* Effect.sleep(Duration.seconds(2));
  yield* Fiber.interrupt(dashboard.fiber).pipe(
    Effect.timeout(Duration.seconds(3)),
    Effect.ignore,
  );
});
