import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { ApplyEvent } from "../Cli/Event.ts";
import type { ActionState } from "../State/ActionState.ts";
import type { ResourceState } from "../State/ResourceState.ts";
import type { StateService } from "../State/State.ts";
import { encodeState } from "../State/StateEncoding.ts";
import { toGraph } from "./Graph.ts";
import type { DashboardPlan } from "./PlanJson.ts";

/**
 * A live apply session, as reported by a deploying alchemy process through
 * the DashboardReporter Cli decorator. Kept in memory so browsers that
 * connect mid-apply can replay the full event log from the snapshot.
 */
export interface ApplySessionState {
  sessionId: string;
  plan: DashboardPlan;
  events: { seq: number; event: ApplyEvent }[];
  done: boolean;
  startedAt: string;
}

/**
 * A plan awaiting browser-side approval (`deploy --ui` without `--yes`).
 * The deploying process polls `/api/approval/status` while the browser
 * shows the plan and an approve/reject choice.
 */
export interface PendingApproval {
  id: string;
  plan: DashboardPlan;
  /** undefined while the user is deciding */
  approved?: boolean;
}

type ServerMessage =
  | {
      kind: "snapshot";
      session: ApplySessionState | null;
      approval: PendingApproval | null;
    }
  | { kind: "apply-start"; session: ApplySessionState }
  | { kind: "apply-event"; seq: number; event: ApplyEvent }
  | { kind: "apply-done" }
  | { kind: "approval-request"; approval: PendingApproval }
  | { kind: "approval-done"; id: string; approved: boolean };

const sse = (message: ServerMessage) => `data: ${JSON.stringify(message)}\n\n`;

export interface DashboardServerOptions {
  state: StateService;
  stack: string;
  stage: string;
  /**
   * Computes the plan for a stage (diff of the stack file, re-evaluated
   * under that stage, against state). Fully provided by the caller;
   * failures are expected (e.g. missing credentials) and must be surfaced
   * as an unavailable plan rather than an error.
   */
  plan?: (stage: string) => Effect.Effect<DashboardPlan>;
}

/**
 * Locate the prebuilt dashboard SPA (`@alchemy.run/dashboard/dist`).
 * `@alchemy.run/dashboard` is an optional peer dependency — returns
 * undefined when it isn't installed. Overridable via
 * `ALCHEMY_DASHBOARD_DIST` for development.
 */
export const resolveDistDir = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const override = process.env.ALCHEMY_DASHBOARD_DIST;
  if (override) {
    return (yield* fs.exists(override).pipe(Effect.orElseSucceed(() => false)))
      ? override
      : undefined;
  }
  const resolved = yield* Effect.try(() =>
    import.meta.resolve("@alchemy.run/dashboard/package.json"),
  ).pipe(Effect.option);
  if (resolved._tag === "Some") {
    const pkgDir = path.dirname(new URL(resolved.value).pathname);
    const dist = path.join(pkgDir, "dist");
    if (yield* fs.exists(dist).pipe(Effect.orElseSucceed(() => false))) {
      return dist;
    }
  }
  return undefined;
});

const FALLBACK_HTML = `<!doctype html>
<html><head><title>alchemy dashboard</title></head>
<body style="font-family: ui-monospace, monospace; background: #0b0b0f; color: #e2e2e8; padding: 4rem;">
<h1>alchemy dashboard</h1>
<p>The dashboard UI bundle was not found (<code>@alchemy.run/dashboard/dist</code>).</p>
<p>The JSON API is live — try <a style="color:#8f8fff" href="/api/graph">/api/graph</a>.</p>
<p>To develop the UI, run <code>vite dev</code> in <code>packages/dashboard</code> with
<code>ALCHEMY_DASHBOARD_API</code> pointed at this server.</p>
</body></html>`;

/**
 * Read every persisted resource/action state for (stack, stage).
 */
const readStates = ({ state, stack, stage }: DashboardServerOptions) =>
  Effect.gen(function* () {
    const fqns = yield* state.list({ stack, stage });
    const states = yield* Effect.forEach(
      fqns,
      (fqn) => state.get({ stack, stage, fqn }),
      { concurrency: 16 },
    );
    return states.filter(
      (s): s is ResourceState | ActionState => s !== undefined,
    );
  });

/**
 * Start the dashboard HTTP server: a small JSON API over the state store
 * plus the static SPA bundle. Returns the formatted server address; serving
 * continues for as long as the surrounding scope stays open.
 */
export const serve = Effect.fn(function* (options: DashboardServerOptions) {
  const { state, stack, stage, plan } = options;
  const distDir = yield* resolveDistDir();
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const server = yield* HttpServer.HttpServer;

  // live apply hub: current session + broadcast to SSE subscribers
  const pubsub = yield* PubSub.unbounded<string>();
  let current: ApplySessionState | undefined;
  let approval: PendingApproval | undefined;

  // Plan computation re-evaluates the entire stack (bundling included) —
  // cache per stage with a TTL and dedupe concurrent requests, so page
  // reloads don't repeatedly starve the server. Cleared when an apply
  // completes so the next request reflects the new state.
  const planEffects = new Map<string, Effect.Effect<DashboardPlan>>();
  const planFor = (stg: string) =>
    Effect.gen(function* () {
      if (plan === undefined) {
        return {
          available: false,
          error: "plan not enabled",
          resources: {},
          deletions: {},
          actions: {},
          cycleMembers: [],
        } satisfies DashboardPlan;
      }
      let cached = planEffects.get(stg);
      if (cached === undefined) {
        cached = yield* Effect.cachedWithTTL(plan(stg), "30 seconds");
        planEffects.set(stg, cached);
      }
      return yield* cached;
    });

  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const url = new URL(request.url, "http://localhost");
    const route = url.pathname;
    const stg = url.searchParams.get("stage") ?? stage;

    if (route === "/api/health") {
      return yield* HttpServerResponse.json({ ok: true, stack, stage });
    }
    if (route === "/api/apply/start" && request.method === "POST") {
      const body = (yield* request.json) as unknown as {
        sessionId: string;
        plan: DashboardPlan;
      };
      current = {
        sessionId: body.sessionId,
        plan: body.plan,
        events: [],
        done: false,
        startedAt: new Date().toISOString(),
      };
      yield* PubSub.publish(
        pubsub,
        sse({ kind: "apply-start", session: current }),
      );
      return yield* HttpServerResponse.json({ ok: true });
    }
    if (route === "/api/apply/event" && request.method === "POST") {
      const body = (yield* request.json) as unknown as {
        sessionId: string;
        seq: number;
        event: ApplyEvent;
      };
      if (current?.sessionId === body.sessionId) {
        current.events.push({ seq: body.seq, event: body.event });
        yield* PubSub.publish(
          pubsub,
          sse({ kind: "apply-event", seq: body.seq, event: body.event }),
        );
      }
      return yield* HttpServerResponse.json({ ok: true });
    }
    if (route === "/api/apply/done" && request.method === "POST") {
      const body = (yield* request.json) as unknown as { sessionId: string };
      if (current?.sessionId === body.sessionId) {
        current.done = true;
        planEffects.clear();
        yield* PubSub.publish(pubsub, sse({ kind: "apply-done" }));
      }
      return yield* HttpServerResponse.json({ ok: true });
    }
    if (route === "/api/approval/request" && request.method === "POST") {
      const body = (yield* request.json) as unknown as {
        id: string;
        plan: DashboardPlan;
      };
      approval = { id: body.id, plan: body.plan };
      yield* PubSub.publish(
        pubsub,
        sse({ kind: "approval-request", approval }),
      );
      return yield* HttpServerResponse.json({ ok: true });
    }
    if (route === "/api/approval/status") {
      const id = url.searchParams.get("id");
      return yield* HttpServerResponse.json({
        approved:
          approval !== undefined && approval.id === id
            ? (approval.approved ?? null)
            : null,
      });
    }
    if (route === "/api/approval/decide" && request.method === "POST") {
      const body = (yield* request.json) as unknown as {
        id: string;
        approved: boolean;
      };
      if (approval?.id === body.id && approval.approved === undefined) {
        approval.approved = body.approved;
        yield* PubSub.publish(
          pubsub,
          sse({ kind: "approval-done", id: body.id, approved: body.approved }),
        );
      }
      return yield* HttpServerResponse.json({ ok: true });
    }
    if (route === "/api/events") {
      // SSE: subscribe first, then snapshot, so nothing is lost in between.
      // Heartbeat comments defeat idle timeouts (Bun.serve kills responses
      // idle for >10s); EventSource ignores `:` lines.
      const body = Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(pubsub);
          const snapshot = sse({
            kind: "snapshot",
            session: current ?? null,
            approval:
              approval !== undefined && approval.approved === undefined
                ? approval
                : null,
          });
          const heartbeat = Stream.fromSchedule(
            Schedule.spaced("8 seconds"),
          ).pipe(Stream.map(() => ":ping\n\n"));
          return Stream.make(snapshot).pipe(
            Stream.concat(
              Stream.fromSubscription(subscription).pipe(
                Stream.merge(heartbeat),
              ),
            ),
          );
        }),
      ).pipe(Stream.map((chunk) => new TextEncoder().encode(chunk)));
      return HttpServerResponse.stream(body, {
        contentType: "text/event-stream",
        headers: {
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    if (route === "/api/meta") {
      const stages = yield* state
        .listStages(stack)
        .pipe(Effect.orElseSucceed(() => [stage] as const));
      return yield* HttpServerResponse.json({ stack, stage, stages });
    }
    if (route === "/api/graph") {
      const states = yield* readStates({ state, stack, stage: stg });
      return yield* HttpServerResponse.json(toGraph(states));
    }
    if (route === "/api/resource") {
      const fqn = url.searchParams.get("fqn");
      if (!fqn) {
        return HttpServerResponse.empty({ status: 400 });
      }
      const value = yield* state.get({ stack, stage: stg, fqn });
      return value === undefined
        ? HttpServerResponse.empty({ status: 404 })
        : yield* HttpServerResponse.json(encodeState(value));
    }
    if (route === "/api/plan") {
      // While an apply is streaming, its plan is authoritative AND
      // recomputing would re-evaluate the whole stack inside the deploying
      // process (starving the event loop mid-apply for `--ui`).
      if (current !== undefined && !current.done && stg === stage) {
        return yield* HttpServerResponse.json(current.plan);
      }
      return yield* HttpServerResponse.json(yield* planFor(stg));
    }
    if (route === "/api/outputs") {
      const output = yield* state
        .getOutput({ stack, stage: stg })
        .pipe(Effect.orElseSucceed(() => undefined));
      return yield* HttpServerResponse.json(output ?? null);
    }
    if (route.startsWith("/api/")) {
      return HttpServerResponse.empty({ status: 404 });
    }

    // static SPA
    if (distDir === undefined) {
      return HttpServerResponse.html(FALLBACK_HTML);
    }
    const rel = route === "/" ? "index.html" : route.slice(1);
    const file = path.join(distDir, path.normalize(rel));
    // prevent path traversal + SPA-fallback unknown routes to index.html
    const exists =
      file.startsWith(distDir) &&
      (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)));
    return yield* HttpServerResponse.file(
      exists ? file : path.join(distDir, "index.html"),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.as(
        Console.error(cause),
        HttpServerResponse.empty({ status: 500 }),
      ),
    ),
  );

  yield* server.serve(handler);
  return HttpServer.formatAddress(server.address);
});
