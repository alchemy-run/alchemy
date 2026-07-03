import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
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
import {
  assembleScene,
  type Scene,
  type SessionInput,
  type StackStructure,
  type TimelineEntry,
} from "./Scene.ts";

/**
 * A plan awaiting browser-side approval (`deploy --ui` without `--yes`).
 * The deploying process polls `/api/approval/status` while the browser
 * shows the plan and an approve/reject choice.
 */
interface PendingApproval {
  id: string;
  plan: DashboardPlan;
  /** undefined while the user is deciding */
  approved?: boolean;
}

/**
 * The SSE protocol is a single message kind: the full scene, re-assembled
 * server-side on every change. The SPA renders it verbatim — no client
 * merging, no precedence rules, no identity joins.
 */
type ServerMessage = { kind: "scene"; scene: Scene };

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
  /**
   * Evaluates the stack's SHAPE for a stage (resources + binding sids, no
   * planning) — fast and credential-free; feeds the "defined but not
   * deployed" ghosts so an empty stage never renders blank.
   */
  structure?: (stage: string) => Effect.Effect<StackStructure>;
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
<p>The JSON API is live — try <a style="color:#8f8fff" href="/api/scene">/api/scene</a>.</p>
<p>To develop the UI, run <code>vite dev</code> in <code>packages/dashboard</code> with
<code>ALCHEMY_DASHBOARD_API</code> pointed at this server.</p>
</body></html>`;

/**
 * Start the dashboard HTTP server: the scene API over the state store plus
 * the static SPA bundle. Returns the formatted server address; serving
 * continues for as long as the surrounding scope stays open.
 */
export const serve = Effect.fn(function* (options: DashboardServerOptions) {
  const { state, stack, stage, plan, structure } = options;
  const distDir = yield* resolveDistDir();
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const server = yield* HttpServer.HttpServer;

  const pubsub = yield* PubSub.unbounded<string>();

  // ── scene inputs (server-owned, single source of truth) ───────────────
  let revision = 0;
  let session: SessionInput | undefined;
  let approval: PendingApproval | undefined;

  // Per-resource deployment timelines (status transitions + notes + logs),
  // persisted across sessions so "view this resource's deploy logs" works
  // after the apply completes. A resource's timeline resets when its next
  // lifecycle operation begins.
  const TIMELINE_CAP = 500;
  const timelines = new Map<string, TimelineEntry[]>();
  let timelineResets = new Set<string>();
  const IN_FLIGHT = new Set([
    "creating",
    "updating",
    "replacing",
    "deleting",
    "creating replacement",
    "pre-creating",
    "running",
  ]);
  const recordTimeline = (seq: number, event: ApplyEvent) => {
    if (
      event.kind !== "status-change" &&
      event.kind !== "annotate" &&
      event.kind !== "log"
    ) {
      // v2 kinds (op-start / op-end / annotation / future ones) are journal
      // detail the v1 timeline doesn't render — ignore them.
      return;
    }
    if ("bindingId" in event && event.bindingId) {
      return;
    }
    if (
      event.kind === "status-change" &&
      IN_FLIGHT.has(event.status) &&
      !timelineResets.has(event.id)
    ) {
      timelineResets.add(event.id);
      timelines.set(event.id, []);
    }
    const entries = timelines.get(event.id) ?? [];
    entries.push(
      event.kind === "status-change"
        ? {
            key: seq,
            level: "status",
            message: event.message
              ? `${event.status} — ${event.message}`
              : event.status,
          }
        : event.kind === "annotate"
          ? { key: seq, level: "note", message: event.message }
          : { key: seq, level: event.level, message: event.message },
    );
    if (entries.length > TIMELINE_CAP) {
      entries.splice(0, entries.length - TIMELINE_CAP);
    }
    timelines.set(event.id, entries);
  };

  // Persisted states per stage, cached: reading the state store can be
  // slow (HTTP backends) and must not run per SSE event. Refreshed on
  // demand with a TTL and explicitly after an apply completes.
  const STATES_TTL_MS = 10_000;
  const statesCache = new Map<
    string,
    { at: number; states: (ResourceState | ActionState)[] }
  >();
  const stateErrors = new Map<string, string>();
  const readStates = (stg: string, force = false) =>
    Effect.gen(function* () {
      const cached = statesCache.get(stg);
      if (!force && cached && Date.now() - cached.at < STATES_TTL_MS) {
        return cached.states;
      }
      // bounded: a hanging state backend must surface as an error in the
      // scene, not an endlessly-pending page
      const fqns = yield* state.list({ stack, stage: stg }).pipe(
        Effect.timeout("20 seconds"),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            stateErrors.set(stg, Cause.pretty(cause).split("\n")[0] ?? "");
            return [] as readonly string[];
          }),
        ),
      );
      const states = yield* Effect.forEach(
        fqns,
        (fqn) =>
          state.get({ stack, stage: stg, fqn }).pipe(
            Effect.timeout("20 seconds"),
            Effect.orElseSucceed(() => undefined),
          ),
        { concurrency: 16 },
      );
      const settled = states.filter(
        (s): s is ResourceState | ActionState => s !== undefined,
      );
      if (fqns.length > 0 || !stateErrors.has(stg)) {
        stateErrors.delete(stg);
        statesCache.set(stg, { at: Date.now(), states: settled });
      }
      return settled;
    });

  // Plan computation re-evaluates the entire stack (bundling included) —
  // compute lazily per stage, dedupe concurrent requests, keep the last
  // result. Cleared when an apply completes. A scene can be served before
  // the plan lands (planReady: false); when it lands the scene is
  // re-broadcast.
  const lastPlans = new Map<string, DashboardPlan>();
  const lastStructures = new Map<string, StackStructure>();
  const planInFlight = new Set<string>();
  // computations run on a server-scoped worker fiber (request scopes close
  // when the response completes, which would kill a fork)
  const planQueue = yield* Queue.unbounded<string>();
  const requestPlan = (stg: string) =>
    plan === undefined || planInFlight.has(stg) || lastPlans.has(stg)
      ? Effect.void
      : Effect.gen(function* () {
          planInFlight.add(stg);
          yield* Queue.offer(planQueue, stg);
        });

  const buildScene = (stg: string) =>
    Effect.gen(function* () {
      const states = yield* readStates(stg);
      const stages = yield* state
        .listStages(stack)
        .pipe(Effect.orElseSucceed(() => [stage] as const));
      // plan precedence: pending approval > active session > computed plan
      const computed = lastPlans.get(stg);
      const overlay =
        stg !== stage
          ? computed
          : approval !== undefined && approval.approved === undefined
            ? approval.plan
            : session !== undefined && (!session.done || computed === undefined)
              ? session.plan
              : computed;
      return assembleScene({
        revision: ++revision,
        stack,
        stage: stg,
        stages: [...new Set([...stages, stage])].sort(),
        states,
        plan: overlay,
        planReady:
          overlay !== undefined || (plan === undefined && stg === stage),
        planError: overlay?.available === false ? overlay.error : undefined,
        // the session belongs to the server's stage
        session: stg === stage ? session : undefined,
        timelines: stg === stage ? timelines : new Map(),
        structure: lastStructures.get(stg),
        stateError: stateErrors.get(stg),
        approvalId:
          stg === stage && approval !== undefined
            ? approval.approved === undefined
              ? approval.id
              : undefined
            : undefined,
      });
    });

  const broadcast = (stg: string) =>
    Effect.gen(function* () {
      const scene = yield* buildScene(stg);
      yield* PubSub.publish(pubsub, sse({ kind: "scene", scene }));
    }).pipe(Effect.ignore);

  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const url = new URL(request.url, "http://localhost");
    const route = url.pathname;
    const stg = url.searchParams.get("stage") ?? stage;

    if (route === "/api/health") {
      return yield* HttpServerResponse.json({ ok: true, stack, stage });
    }

    // ── apply session ingest (from the DashboardReporter tee) ──────────
    if (route === "/api/apply/start" && request.method === "POST") {
      const body = (yield* request.json) as unknown as {
        sessionId: string;
        plan: DashboardPlan;
      };
      // a new operation begins: the previous session's overlay (results,
      // ghosts) and any stale approval are retired with it
      session = {
        sessionId: body.sessionId,
        plan: body.plan,
        events: [],
        done: false,
      };
      approval = undefined;
      // timelines reset lazily per resource as its first in-flight status
      // arrives in THIS session
      timelineResets = new Set();
      yield* broadcast(stage);
      return yield* HttpServerResponse.json({ ok: true });
    }
    if (route === "/api/apply/event" && request.method === "POST") {
      const body = (yield* request.json) as unknown as {
        sessionId: string;
        seq: number;
        event: ApplyEvent;
      };
      if (session?.sessionId === body.sessionId) {
        session.events.push({ seq: body.seq, event: body.event });
        recordTimeline(body.seq, body.event);
        yield* broadcast(stage);
      }
      return yield* HttpServerResponse.json({ ok: true });
    }
    if (route === "/api/apply/done" && request.method === "POST") {
      const body = (yield* request.json) as unknown as { sessionId: string };
      if (session?.sessionId === body.sessionId) {
        session.done = true;
        // the world changed: refresh state now and recompute the plan
        lastPlans.delete(stage);
        yield* readStates(stage, true).pipe(Effect.ignore);
        yield* broadcast(stage);
        yield* requestPlan(stage);
      }
      return yield* HttpServerResponse.json({ ok: true });
    }

    // ── browser-side approval (deploy --ui without --yes) ──────────────
    if (route === "/api/approval/request" && request.method === "POST") {
      const body = (yield* request.json) as unknown as {
        id: string;
        plan: DashboardPlan;
      };
      approval = { id: body.id, plan: body.plan };
      // the pending plan is a NEW operation: retire the previous
      // session's result overlay so the canvas shows what WILL happen,
      // not what last happened
      session = undefined;
      yield* broadcast(stage);
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
        yield* broadcast(stage);
      }
      return yield* HttpServerResponse.json({ ok: true });
    }

    // ── scene ───────────────────────────────────────────────────────────
    if (route === "/api/scene") {
      const scene = yield* buildScene(stg);
      yield* requestPlan(stg);
      return yield* HttpServerResponse.json(scene);
    }
    if (route === "/api/events") {
      // SSE: subscribe first, then snapshot, so nothing is lost in between.
      // Heartbeat comments defeat idle timeouts (Bun.serve kills responses
      // idle for >10s); EventSource ignores `:` lines.
      const body = Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(pubsub);
          const scene = yield* buildScene(stage);
          // the SPA's default view loads exclusively over this stream —
          // kick the structure/plan evaluation here, or a fresh dashboard
          // would wait forever for a /api/scene request that never comes
          yield* requestPlan(stage);
          const heartbeat = Stream.fromSchedule(
            Schedule.spaced("8 seconds"),
          ).pipe(Stream.map(() => ":ping\n\n"));
          return Stream.make(sse({ kind: "scene", scene })).pipe(
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

    // ── raw data (debugging / power users) ─────────────────────────────
    if (route === "/api/graph") {
      return yield* HttpServerResponse.json(toGraph(yield* readStates(stg)));
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

  // plan worker: computes plans sequentially on the server's scope and
  // re-broadcasts the scene when each lands
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      while (true) {
        const stg = yield* Queue.take(planQueue);
        // fast structure pass first: the canvas can render the stack's
        // shape within seconds while the full plan (which bundles and
        // diffs) is still computing
        if (structure !== undefined && !lastStructures.has(stg)) {
          lastStructures.set(stg, yield* structure(stg));
          yield* broadcast(stg);
        }
        if (plan === undefined) {
          continue;
        }
        const result = yield* plan(stg).pipe(
          Effect.ensuring(Effect.sync(() => planInFlight.delete(stg))),
        );
        lastPlans.set(stg, result);
        yield* broadcast(stg);
      }
    }).pipe(Effect.ignore),
  );
  // NOTE: the plan is NOT computed eagerly — a full stack re-evaluation
  // (bundling included) can starve this process's event loop and hang the
  // first page load. The first /api/scene request queues it; the page
  // renders immediately with planReady:false and updates when it lands.

  return HttpServer.formatAddress(server.address);
});
