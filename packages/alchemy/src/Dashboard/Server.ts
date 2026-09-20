import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { StateService } from "../State/State.ts";
import { encodeState } from "../State/StateEncoding.ts";
import {
  applyDeploymentRecord,
  foldJournal,
  fromSnapshot,
  snapshotOf,
  type StackStructure,
} from "./Document.ts";
import * as DocumentHost from "./DocumentHost.ts";
import type { DashboardEvent } from "./Event.ts";
import type { DeploymentHistory } from "./History.ts";
import type { DashboardPlan } from "./PlanJson.ts";
import {
  annotationsOf,
  listGroupsOf,
  summaryOf,
  tableRowsOf,
  waterfallSpansOf,
} from "./Projections.ts";

/**
 * The CLI-launched dashboard server: one incremental
 * {@link DocumentHost} per stage over the state store, an apply-event
 * ingest for the reporter tee, browser-side plan approvals, and the static
 * SPA bundle.
 *
 * Endpoints:
 *
 * - `GET  /api/health`                  — liveness, target, live SSE client count
 * - `POST /api/apply/start|event|done`  — the reporter tee (see `Reporter.ts`)
 * - `POST /api/approval/request|decide`, `GET /api/approval/status` — browser approvals
 * - `GET  /api/v2/document`             — {@link DocumentHost.DocumentHost.snapshot}
 * - `GET  /api/v2/events`               — SSE `snapshot` + `patches` frames
 * - `GET  /api/v2/deployments[/:v]`     — deployment history (404 without one)
 * - `GET  /api/v2/projections`          — summary | table | waterfall | list
 * - `GET  /api/resource?fqn=`           — one persisted state, encoded
 * - `GET  /api/outputs`                 — the stack's persisted outputs
 * - everything else                     — the SPA bundle (SPA fallback to index.html)
 *
 * `?stage=` selects a stage other than the server's own on the read
 * endpoints; the apply/approval ingest always targets the server's stage.
 */

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

/** The live apply session the reporter tee is streaming, if any. */
interface ApplySession {
  sessionId: string;
  done: boolean;
}

export interface DashboardServerOptions {
  state: StateService;
  /**
   * Deployment history for the store, when it keeps one. Feature-detected:
   * without it `/api/v2/deployments*` 404 and the document never restores
   * a past run (see {@link DocumentHost.DocumentHostOptions.history}).
   */
  history?: DeploymentHistory;
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
  /**
   * Fired (fire-and-forget, may be invoked repeatedly) when an SSE client
   * attaches. The launcher uses the first firing to skip opening a fresh
   * browser tab when a previous tab has already reconnected to the
   * restarted server.
   */
  onClientConnected?: Effect.Effect<void>;
  /**
   * The CLI command this (run-scoped) dashboard serves. During a
   * `destroy --ui` run the background plan worker's DEPLOY plan overlay
   * ("+ create" on everything) is noise — the stage is being torn down —
   * so it is suppressed and the canvas shows plain structure ghosts.
   * Absent for the standalone `alchemy dashboard`, where previewing the
   * deploy plan is the whole point.
   */
  command?: "deploy" | "destroy" | "plan";
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
<p>The JSON API is live — try <a style="color:#8f8fff" href="/api/v2/document">/api/v2/document</a>.</p>
<p>To develop the UI, run <code>vite dev</code> in <code>packages/dashboard</code> with
<code>ALCHEMY_DASHBOARD_API</code> pointed at this server.</p>
</body></html>`;

const SSE_OPTIONS = {
  contentType: "text/event-stream",
  headers: {
    "cache-control": "no-cache",
    connection: "keep-alive",
  },
};

/**
 * Start the dashboard HTTP server: the document API over the state store
 * plus the static SPA bundle. Returns the formatted server address; serving
 * continues for as long as the surrounding scope stays open.
 */
export const serve = Effect.fn(function* (options: DashboardServerOptions) {
  const {
    state,
    history,
    stack,
    stage,
    plan,
    structure,
    onClientConnected,
    command,
  } = options;
  const notifyClientConnected = onClientConnected ?? Effect.void;
  const distDir = yield* resolveDistDir();
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const server = yield* HttpServer.HttpServer;

  // Shutdown latch for the SSE streams: they halt (end normally, so the
  // response's ReadableStream CLOSES) when this fires. Ending them by
  // fiber interruption instead would surface as `controller.error(...)`
  // in Stream.toReadableStream and crash the process on exit with
  // "All fibers interrupted without error".
  const closed = yield* Deferred.make<void>();

  /**
   * SSE bodies are converted to web ReadableStreams by a pump fiber WE
   * fork, detached from the serve scope, and handed to Bun as a raw
   * `Response`. The platform's Stream-body path parks its driver fiber in
   * the serve scope, whose close runs in PARALLEL with our finalizers —
   * so it interrupts in-flight bodies before the `closed` latch can halt
   * them, and `Stream.toReadableStream` reports the interruption as
   * `controller.error(...)`, crashing the process on exit. Here nothing
   * ever interrupts the pump (it ends via the latch or client cancel) and
   * an interrupt exit maps to a clean close.
   */
  const sseReadable = (
    make: Effect.Effect<Stream.Stream<string>, never, Scope.Scope>,
  ): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder();
    let fiber: Fiber.Fiber<void, unknown> | undefined;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        fiber = Effect.runFork(
          Effect.scoped(
            Effect.flatMap(make, (stream) =>
              Stream.runForEach(stream, (chunk) =>
                Effect.sync(() => controller.enqueue(encoder.encode(chunk))),
              ),
            ),
          ),
        );
        fiber.addObserver((exit) => {
          try {
            if (
              exit._tag === "Failure" &&
              !Cause.hasInterruptsOnly(exit.cause)
            ) {
              controller.error(Cause.squash(exit.cause));
            } else {
              controller.close();
            }
          } catch {
            // the response was already cancelled/closed — nothing to report
          }
        });
      },
      cancel() {
        if (fiber !== undefined) {
          return Effect.runPromise(Effect.asVoid(Fiber.interrupt(fiber))).catch(
            () => undefined,
          );
        }
      },
    });
  };

  // Live SSE subscriber count, exposed on /api/health — launchers use it
  // to decide whether opening a browser tab would be a duplicate.
  let sseClients = 0;
  let session: ApplySession | undefined;
  let approval: PendingApproval | undefined;

  // ── document hosts (one incremental document per stage) ─────────────────
  // Hosts fork their patch flusher on the SERVER's scope (request scopes
  // close with the response), created lazily on the first request for a
  // stage. `hosts.get(...)` (no create) is used on the ingest paths so
  // deploys with no subscriber pay nothing.
  const serverScope = yield* Effect.scope;
  const hosts = new Map<string, DocumentHost.DocumentHost>();
  const hostGate = Semaphore.makeUnsafe(1);
  const hostFor = (stg: string) =>
    Semaphore.withPermits(
      hostGate,
      1,
    )(
      Effect.gen(function* () {
        const existing = hosts.get(stg);
        if (existing !== undefined) {
          return existing;
        }
        const host = yield* DocumentHost.make({
          state,
          history,
          stack,
          stage: stg,
        }).pipe(Effect.provideService(Scope.Scope, serverScope));
        // overlay whatever the plan worker already computed for this stage
        const lastPlan = lastPlans.get(stg);
        if (lastPlan !== undefined) {
          yield* host.applyPlan(lastPlan);
        }
        const lastStructure = lastStructures.get(stg);
        if (lastStructure !== undefined) {
          yield* host.applyStructure(lastStructure);
        }
        hosts.set(stg, host);
        return host;
      }),
    );
  /** Best-effort notification of an existing host (never creates one). */
  const withHost = (
    stg: string,
    f: (host: DocumentHost.DocumentHost) => Effect.Effect<void>,
  ) => {
    const host = hosts.get(stg);
    return host === undefined ? Effect.void : f(host);
  };

  // Plan computation re-evaluates the entire stack (bundling included) —
  // compute lazily per stage, dedupe concurrent requests, keep the last
  // result. Cleared when an apply completes. A document can be served
  // before the plan lands; when it lands the plan overlay reaches every
  // subscriber as a structure patch.
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

  /** Serialize one projection of a document, or undefined for an unknown view. */
  const projectionOf = (
    view: string,
    doc: DocumentHost.DocumentHost["document"],
  ) =>
    view === "summary"
      ? summaryOf(doc)
      : view === "table"
        ? tableRowsOf(doc)
        : view === "waterfall"
          ? waterfallSpansOf(doc)
          : view === "list"
            ? listGroupsOf(doc)
            : undefined;

  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const url = new URL(request.url, "http://localhost");
    const route = url.pathname;
    const stg = url.searchParams.get("stage") ?? stage;

    if (route === "/api/health") {
      return yield* HttpServerResponse.json({
        ok: true,
        stack,
        stage,
        clients: sseClients,
      });
    }

    // ── apply session ingest (from the reporter tee) ───────────────────
    if (route === "/api/apply/start" && request.method === "POST") {
      const body = (yield* request.json) as unknown as {
        sessionId: string;
        plan: DashboardPlan;
      };
      // a new operation begins: the previous session's overlay (results,
      // ghosts) and any stale approval are retired with it
      session = { sessionId: body.sessionId, done: false };
      approval = undefined;
      // hostFor (not withHost): with --ui --yes the apply starts before the
      // browser tab connects — the host must exist NOW so live events fold
      // into the document the first tab's snapshot is built from
      const applyHost = yield* hostFor(stage);
      yield* applyHost.clearApproval();
      yield* applyHost.applyPlan(body.plan);
      // a plan whose only work is deletions is a destroy
      const applyCommand =
        body.plan.available &&
        Object.keys(body.plan.resources).length === 0 &&
        Object.keys(body.plan.deletions).length > 0
          ? "destroy"
          : "deploy";
      yield* applyHost.deploymentStarted(applyCommand);
      return yield* HttpServerResponse.json({ ok: true });
    }
    if (route === "/api/apply/event" && request.method === "POST") {
      const body = (yield* request.json) as unknown as {
        sessionId: string;
        seq: number;
        event: DashboardEvent;
      };
      if (session?.sessionId === body.sessionId) {
        yield* withHost(stage, (host) => host.applyEvent(body.event));
      }
      return yield* HttpServerResponse.json({ ok: true });
    }
    if (route === "/api/apply/done" && request.method === "POST") {
      const body = (yield* request.json) as unknown as {
        sessionId: string;
        outcome?: "succeeded" | "failed";
      };
      if (session?.sessionId === body.sessionId) {
        session.done = true;
        // the world changed: recompute the plan
        lastPlans.delete(stage);
        yield* withHost(stage, (host) =>
          Effect.gen(function* () {
            // rebuild the persisted baseline (retires plan ghosts), then
            // re-apply the structure pass; the fresh plan re-lands via the
            // plan worker notification below.
            //
            // Capture the edge set first: after a DESTROY the baseline is
            // empty and the structure ghosts only know binding edges —
            // restoring the captured dependency edges keeps the topology
            // (and therefore the layout) identical, so the graph recolors
            // to deleted ghosts IN PLACE instead of morphing.
            const previousEdges = [...host.document.structure.edges.values()];
            yield* host.refreshStates();
            const lastStructure = lastStructures.get(stage);
            if (lastStructure !== undefined) {
              yield* host.applyStructure(lastStructure);
            }
            yield* host.restoreEdges(previousEdges);
            yield* host.refreshOutputs();
            yield* host.deploymentDone(body.outcome);
          }),
        );
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
      // hostFor (not withHost): on the fresh-launch path (`deploy --ui`
      // spawning its own dashboard) the approval arrives BEFORE any browser
      // tab has connected — the host must be created now so the approval is
      // already in the snapshot the first tab receives, otherwise the
      // approve button never renders and the deploy waits forever
      const approvalHost = yield* hostFor(stage);
      yield* approvalHost.applyPlan(body.plan);
      yield* approvalHost.setApproval({ id: body.id, plan: body.plan });
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
        if (!body.approved) {
          // rejected: back to idle — the computed plan may own the overlay
          // again. On APPROVE the overlay stays until /api/apply/start
          // replaces it, so the review graph can't flash the background
          // deploy plan in the decide→start window.
          yield* withHost(stage, (host) =>
            Effect.gen(function* () {
              yield* host.clearApproval();
              // gate-skipped overlays never re-apply on their own — restore
              // the cached shape/plan now and queue a fresh computation
              const lastStructure = lastStructures.get(stage);
              if (lastStructure !== undefined) {
                yield* host.applyStructure(lastStructure);
              }
              const lastPlan = lastPlans.get(stage);
              if (lastPlan !== undefined) {
                yield* host.applyPlan(lastPlan);
              }
            }),
          );
          yield* requestPlan(stage);
        }
      }
      return yield* HttpServerResponse.json({ ok: true });
    }

    // ── document + patch protocol + history ────────────────────────────
    if (route === "/api/v2/document") {
      const host = yield* hostFor(stg);
      yield* requestPlan(stg);
      return yield* HttpServerResponse.json(host.snapshot());
    }
    if (route === "/api/v2/events") {
      // SSE: one `snapshot` frame, then debounced `patches` frames.
      // Heartbeat comments defeat idle timeouts (Bun.serve kills responses
      // idle for >10s by default); EventSource ignores `:` lines.
      yield* notifyClientConnected;
      const host = yield* hostFor(stg);
      yield* requestPlan(stg);
      sseClients++;
      const body = sseReadable(
        Effect.gen(function* () {
          const frames = yield* host.frames;
          const heartbeat = Stream.fromSchedule(
            Schedule.spaced("8 seconds"),
          ).pipe(Stream.map(() => ":ping\n\n"));
          return frames.pipe(
            Stream.map((frame) => `data: ${JSON.stringify(frame)}\n\n`),
            Stream.merge(heartbeat),
            Stream.haltWhen(Deferred.await(closed)),
            Stream.ensuring(
              Effect.sync(() => {
                sseClients--;
              }),
            ),
          );
        }),
      );
      return HttpServerResponse.raw(new Response(body), SSE_OPTIONS);
    }
    if (route === "/api/v2/deployments") {
      if (history === undefined) {
        // feature-detected: stores without history have none to list
        return HttpServerResponse.empty({ status: 404 });
      }
      const before = url.searchParams.get("before");
      const limit = url.searchParams.get("limit");
      const records = yield* history.list({
        stack,
        stage: stg,
        ...(before !== null && Number.isInteger(Number(before))
          ? { before: Number(before) }
          : {}),
        ...(limit !== null && Number.isInteger(Number(limit))
          ? { limit: Number(limit) }
          : {}),
      });
      return yield* HttpServerResponse.json(records);
    }
    if (route.startsWith("/api/v2/deployments/")) {
      if (history === undefined) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const version = Number(route.slice("/api/v2/deployments/".length));
      if (!Number.isInteger(version) || version <= 0) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const record = yield* history.get({ stack, stage: stg, version });
      if (record === undefined) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const events = yield* history
        .readEvents({ stack, stage: stg, version })
        .pipe(
          Effect.catchTag("DeploymentNotFound", () =>
            Effect.succeed([] as const),
          ),
        );
      // historical overlay: the CURRENT structure document with this
      // version's decorations/op-spans/annotations folded over it — the
      // deployment picker swaps overlays without moving the graph
      const live = (yield* hostFor(stg)).snapshot();
      const doc = fromSnapshot({
        revision: 0,
        meta: live.meta,
        structure: live.structure,
        decorations: {},
        timelines: {},
        feed: [],
        annotations: {},
        opSpans: {},
      });
      // before the fold so deployment-start preserves version/meta; after
      // the fold so the store's record (heartbeat, outcome) is authoritative
      applyDeploymentRecord(doc, record);
      foldJournal(doc, events);
      applyDeploymentRecord(doc, record);
      return yield* HttpServerResponse.json({
        record,
        snapshot: snapshotOf(doc),
        // server-side projections so thin clients (TUI) render without
        // re-implementing the fold
        projections: {
          summary: summaryOf(doc),
          tableRows: tableRowsOf(doc),
          waterfallSpans: waterfallSpansOf(doc),
          annotations: annotationsOf(doc),
        },
      });
    }
    if (route === "/api/v2/projections") {
      const view = url.searchParams.get("view") ?? "summary";
      const host = yield* hostFor(stg);
      const doc = host.document;
      const data = projectionOf(view, doc);
      if (data === undefined) {
        return HttpServerResponse.empty({ status: 400 });
      }
      return yield* HttpServerResponse.json({
        view,
        revision: doc.revision,
        data,
      });
    }

    // ── raw data (debugging / power users) ─────────────────────────────
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

  // Fire the shutdown latch on scope close: the detached SSE pumps halt,
  // their responses end cleanly, connections drain, and Bun's graceful
  // `server.stop()` can complete. Without this the pumps (which nothing
  // interrupts by design) would hold their connections open forever.
  yield* Effect.addFinalizer(() => Deferred.succeed(closed, void 0));

  // plan worker: computes plans sequentially on the server's scope and
  // overlays each result onto the stage's document when it lands
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      while (true) {
        const stg = yield* Queue.take(planQueue);
        // fast structure pass first: the canvas can render the stack's
        // shape within seconds while the full plan (which bundles and
        // diffs) is still computing
        if (structure !== undefined && !lastStructures.has(stg)) {
          const shape = yield* structure(stg);
          lastStructures.set(stg, shape);
          yield* withHost(stg, (host) =>
            host.document.approval !== undefined ||
            host.document.deployment?.live === true
              ? Effect.void
              : host.applyStructure(shape),
          );
        }
        if (plan === undefined || command === "destroy") {
          // a destroy-run dashboard never overlays the background DEPLOY
          // plan — "+ create" on a stage being torn down reads as wrong;
          // the destroy plan itself arrives via the approval request
          planInFlight.delete(stg);
          continue;
        }
        const result = yield* plan(stg).pipe(
          Effect.ensuring(Effect.sync(() => planInFlight.delete(stg))),
        );
        lastPlans.set(stg, result);
        // Precedence: a pending approval or a live deployment OWNS the
        // document's plan overlay. The worker's lazily computed deploy
        // plan must never clobber it — otherwise a destroy approval's
        // DELETE tabs flicker into the background deploy plan moments
        // after the review screen renders.
        yield* withHost(stg, (host) =>
          host.document.approval !== undefined ||
          host.document.deployment?.live === true
            ? Effect.void
            : host.applyPlan(result),
        );
      }
    }).pipe(Effect.ignore),
  );
  // NOTE: the plan is NOT computed eagerly — a full stack re-evaluation
  // (bundling included) can starve this process's event loop and hang the
  // first page load. The first document request queues it; the page
  // renders immediately from persisted state and updates when it lands.

  return HttpServer.formatAddress(server.address);
});
