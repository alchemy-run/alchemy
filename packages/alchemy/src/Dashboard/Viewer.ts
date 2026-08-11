import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { StateService } from "../State/State.ts";
import { encodeState } from "../State/StateEncoding.ts";
import {
  applyDeploymentRecord,
  foldJournal,
  fromSnapshot,
  snapshotOf,
} from "./Document.ts";
import * as DocumentHost from "./DocumentHost.ts";
import {
  annotationsOf,
  listGroupsOf,
  summaryOf,
  tableRowsOf,
  waterfallSpansOf,
} from "./Projections.ts";

/**
 * Hosted dashboard viewer: the READ-ONLY half of the dashboard server's
 * API, expressed as a plain `HttpServerRequest -> HttpServerResponse`
 * handler with no platform dependencies (no FileSystem, no Path, no
 * process) so it runs anywhere the effect HTTP types do — a Cloudflare
 * Worker, a Lambda, or a local Bun server.
 *
 * Where {@link serve} (Server.ts) is the CLI-launched dashboard — plan
 * overlays, apply-event ingest, browser approvals — the viewer serves the
 * deployed reality straight from the state store: persisted resources,
 * deployment history, and journals. Point it at any {@link StateService}
 * (typically `makeHttpStateStore` against a deployed state-store worker)
 * and serve the `@alchemy.run/dashboard` SPA next to it (same-origin) and
 * the full dashboard works: structure, decorations, timelines, deployment
 * picker, outputs.
 *
 * Endpoints (all read-only; `?stack=` / `?stage=` select the target):
 *
 * - `GET /api/health`                  — liveness + store probe + resolved target
 * - `GET /api/stacks`                  — every `(stack, stages)` in the store
 * - `GET /api/scene`                   — `{ approval: null }` (approvals are CLI-local)
 * - `GET /api/v2/document`             — {@link DocumentSnapshot}
 * - `GET /api/v2/events`               — SSE `snapshot` + `patches` frames, store-polled
 * - `GET /api/v2/deployments`          — deployment records, newest first
 * - `GET /api/v2/deployments/:version` — record + snapshot + projections
 * - `GET /api/v2/projections`          — summary | table | waterfall | list
 * - `GET /api/resource?fqn=`           — one persisted state, encoded
 * - `GET /api/outputs`                 — the stack's persisted outputs
 */
export interface ViewerOptions {
  state: StateService;
  /**
   * Stack served when a request carries no `?stack=`. Defaults to the
   * first stack (sorted) in the store.
   */
  stack?: string;
  /**
   * Stage served when a request carries no `?stage=`. Defaults to the
   * first stage (sorted) of the resolved stack.
   */
  stage?: string;
  /**
   * How often an open SSE connection re-reads the store (deployment
   * record every tick; full states/outputs when the record changes or a
   * deployment is live).
   * @default 5000 (milliseconds)
   */
  pollMillis?: number;
  /**
   * SSE delivery mode for `/api/v2/events`:
   *
   * - `"stream"` (default): a long-lived response — one snapshot frame,
   *   then live patch frames driven by the store poll. Requires a host
   *   that streams response bodies (Workers, Bun, Node).
   * - `"poll"`: one snapshot frame plus a `retry:` hint, then the
   *   response CLOSES. EventSource's native auto-reconnect turns this
   *   into snapshot polling — the mode for hosts that buffer response
   *   bodies (Lambda Function URLs in BUFFERED invoke mode, some
   *   proxies), where an unending stream would never flush.
   */
  sse?: "stream" | "poll";
  /**
   * Host-provided fields surfaced verbatim on `/api/health` — e.g. which
   * transport the state client rides (service binding vs plain fetch) or
   * which store backend is configured. Diagnostic only; never include
   * secrets.
   */
  diagnostics?: Record<string, unknown>;
}

/**
 * Outcome of resolving the `(stack, stage)` a request targets. The three
 * kinds keep two very different failure modes distinguishable: a store
 * that ERRORS (bad transport, bad auth, wrong URL) must never present as
 * a store that is merely EMPTY.
 */
type ResolvedTarget =
  | { kind: "target"; stack: string; stage: string }
  | { kind: "empty"; message: string }
  | { kind: "unreachable"; message: string };

const SSE_OPTIONS = {
  contentType: "text/event-stream",
  headers: {
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  },
};

/**
 * Build the viewer handler. The returned Effect handles ONE request; give
 * it to a Worker's `fetch`, a router, or `HttpServer.serve` directly.
 */
export const viewer = (options: ViewerOptions) => {
  const { state } = options;
  const poll = options.pollMillis ?? 5000;

  const resolveTarget = (url: URL): Effect.Effect<ResolvedTarget> =>
    Effect.gen(function* () {
      let stack = url.searchParams.get("stack") ?? options.stack;
      if (stack === undefined) {
        const stacks = yield* Effect.result(state.listStacks());
        if (Result.isFailure(stacks)) {
          return {
            kind: "unreachable" as const,
            message: stacks.failure.message,
          };
        }
        stack = [...stacks.success].sort()[0];
        if (stack === undefined) {
          return {
            kind: "empty" as const,
            message: "the state store has no stacks — deploy something first",
          };
        }
      }
      let stage = url.searchParams.get("stage") ?? options.stage;
      if (stage === undefined) {
        const stages = yield* Effect.result(state.listStages(stack));
        if (Result.isFailure(stages)) {
          return {
            kind: "unreachable" as const,
            message: stages.failure.message,
          };
        }
        stage = [...stages.success].sort()[0];
        if (stage === undefined) {
          // A pinned stack that no longer has any stage is the confusing
          // case: name it rather than implying the whole store is empty.
          return {
            kind: "empty" as const,
            message: `stack "${stack}" has no stages in the state store`,
          };
        }
      }
      return { kind: "target" as const, stack, stage };
    });

  const noTarget = (message: string) =>
    HttpServerResponse.jsonUnsafe(
      { error: `${message} — or pass ?stack= and ?stage=` },
      { status: 404 },
    );

  const storeUnreachable = (message: string) =>
    HttpServerResponse.jsonUnsafe(
      { error: `state store unreachable: ${message}` },
      { status: 502 },
    );

  /** One request-scoped host: hydrate, use, tear down with the scope. */
  const withHost = <A, E>(
    target: { stack: string; stage: string },
    f: (host: DocumentHost.DocumentHost) => Effect.Effect<A, E>,
  ) =>
    Effect.scoped(
      Effect.flatMap(
        DocumentHost.make({
          state,
          stack: target.stack,
          stage: target.stage,
        }),
        f,
      ),
    );

  return Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const url = new URL(request.url, "http://localhost");
    const route = url.pathname;

    if (route === "/api/health") {
      // Probe the store explicitly (even when stack/stage are pinned) so
      // health always reflects connectivity, and skip target resolution
      // when the probe fails — it would only re-run the failing call.
      const probe = yield* Effect.result(state.listStacks());
      const resolved = Result.isSuccess(probe)
        ? yield* resolveTarget(url)
        : undefined;
      return HttpServerResponse.jsonUnsafe({
        ok: Result.isSuccess(probe),
        mode: "viewer",
        store: Result.isSuccess(probe)
          ? { ok: true, stacks: probe.success.length }
          : { ok: false, error: probe.failure.message },
        stack: resolved?.kind === "target" ? resolved.stack : undefined,
        stage: resolved?.kind === "target" ? resolved.stage : undefined,
        ...(options.diagnostics !== undefined
          ? { diagnostics: options.diagnostics }
          : {}),
      });
    }

    if (route === "/api/stacks") {
      const stacks = yield* Effect.result(state.listStacks());
      if (Result.isFailure(stacks)) {
        return storeUnreachable(stacks.failure.message);
      }
      const withStages = yield* Effect.forEach(
        [...stacks.success].sort(),
        (stack) =>
          state.listStages(stack).pipe(
            Effect.orElseSucceed(() => [] as readonly string[]),
            Effect.map((stages) => ({ stack, stages: [...stages].sort() })),
          ),
        { concurrency: 8 },
      );
      return HttpServerResponse.jsonUnsafe(withStages);
    }

    // The SPA only reads `scene.approval` (to render the approve button);
    // approvals are a CLI-session concern the hosted viewer never has.
    if (route === "/api/scene") {
      return HttpServerResponse.jsonUnsafe({ approval: null });
    }

    const resolved = yield* resolveTarget(url);
    if (resolved.kind === "unreachable") {
      return storeUnreachable(resolved.message);
    }
    if (resolved.kind === "empty") {
      return noTarget(resolved.message);
    }
    const { stack, stage } = resolved;
    const target = { stack, stage };

    if (route === "/api/v2/document") {
      const snapshot = yield* withHost(target, (host) =>
        Effect.sync(() => host.snapshot()),
      );
      return HttpServerResponse.jsonUnsafe(snapshot);
    }

    if (route === "/api/v2/events") {
      if (options.sse === "poll") {
        // Buffered hosts never flush an unending stream: send one
        // snapshot and close. EventSource reconnects after `retry:` ms,
        // so the client converges by re-snapshotting.
        const snapshot = yield* withHost(target, (host) =>
          Effect.sync(() => host.snapshot()),
        );
        return HttpServerResponse.text(
          `retry: ${poll}\ndata: ${JSON.stringify({ kind: "snapshot", snapshot })}\n\n`,
          { ...SSE_OPTIONS },
        );
      }
      // One `snapshot` frame, then `patches` frames driven by a store
      // poll: the deployment record is re-read every tick (cheap), the
      // full states/outputs only when the record changed or a run is
      // live. The host, its poller, and the store subscriptions all live
      // in the stream's scope — client disconnect tears everything down.
      const frames = Stream.unwrap(
        Effect.gen(function* () {
          const host = yield* DocumentHost.make({ state, stack, stage });
          yield* Effect.forkScoped(
            Effect.gen(function* () {
              let seen = "";
              for (;;) {
                yield* Effect.sleep(Duration.millis(poll));
                yield* host.refreshDeployment().pipe(Effect.ignore);
                const record = host.document.deployment;
                const key =
                  record === undefined
                    ? ""
                    : `${record.version}:${record.live}:${record.endedAt ?? ""}`;
                if (key !== seen || record?.live === true) {
                  seen = key;
                  yield* host.refreshStates().pipe(Effect.ignore);
                  yield* host.refreshOutputs().pipe(Effect.ignore);
                }
              }
            }).pipe(Effect.ignore),
          );
          const stream = yield* host.frames;
          const heartbeat = Stream.fromSchedule(
            Schedule.spaced("8 seconds"),
          ).pipe(Stream.map(() => ":ping\n\n"));
          return stream.pipe(
            Stream.map((frame) => `data: ${JSON.stringify(frame)}\n\n`),
            Stream.merge(heartbeat),
          );
        }),
      );
      return HttpServerResponse.stream(frames.pipe(Stream.encodeText), {
        ...SSE_OPTIONS,
      });
    }

    if (route === "/api/v2/deployments") {
      const deployments = state.deployments;
      if (deployments === undefined) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const before = url.searchParams.get("before");
      const limit = url.searchParams.get("limit");
      const records = yield* deployments
        .list({
          stack,
          stage,
          ...(before !== null && Number.isInteger(Number(before))
            ? { before: Number(before) }
            : {}),
          ...(limit !== null && Number.isInteger(Number(limit))
            ? { limit: Number(limit) }
            : {}),
        })
        .pipe(Effect.orElseSucceed(() => [] as const));
      return HttpServerResponse.jsonUnsafe(records);
    }

    if (route.startsWith("/api/v2/deployments/")) {
      const deployments = state.deployments;
      if (deployments === undefined) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const version = Number(route.slice("/api/v2/deployments/".length));
      if (!Number.isInteger(version) || version <= 0) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const record = yield* deployments
        .get({ stack, stage, version })
        .pipe(Effect.orElseSucceed(() => undefined));
      if (record === undefined) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const events = yield* deployments
        .readEvents({ stack, stage, version })
        .pipe(Effect.orElseSucceed(() => [] as const));
      // historical overlay: the CURRENT structure with this version's
      // journal folded over it (same shape as Server.ts) — the deployment
      // picker swaps overlays without moving the graph
      const live = yield* withHost(target, (host) =>
        Effect.sync(() => host.snapshot()),
      );
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
      applyDeploymentRecord(doc, record);
      foldJournal(doc, events);
      applyDeploymentRecord(doc, record);
      return HttpServerResponse.jsonUnsafe({
        record,
        snapshot: snapshotOf(doc),
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
      const result = yield* withHost(target, (host) =>
        Effect.sync(() => {
          const doc = host.document;
          const data =
            view === "summary"
              ? summaryOf(doc)
              : view === "table"
                ? tableRowsOf(doc)
                : view === "waterfall"
                  ? waterfallSpansOf(doc)
                  : view === "list"
                    ? listGroupsOf(doc)
                    : undefined;
          return data === undefined
            ? undefined
            : { view, revision: doc.revision, data };
        }),
      );
      return result === undefined
        ? HttpServerResponse.empty({ status: 400 })
        : HttpServerResponse.jsonUnsafe(result);
    }

    if (route === "/api/resource") {
      const fqn = url.searchParams.get("fqn");
      if (!fqn) {
        return HttpServerResponse.empty({ status: 400 });
      }
      const value = yield* state
        .get({ stack, stage, fqn })
        .pipe(Effect.orElseSucceed(() => undefined));
      return value === undefined
        ? HttpServerResponse.empty({ status: 404 })
        : HttpServerResponse.jsonUnsafe(encodeState(value));
    }

    if (route === "/api/outputs") {
      const output = yield* state
        .getOutput({ stack, stage })
        .pipe(Effect.orElseSucceed(() => undefined));
      return HttpServerResponse.jsonUnsafe(output ?? null);
    }

    // Non-API paths belong to the static asset layer (the SPA bundle) —
    // reaching the handler means the deployment routed them here anyway.
    return HttpServerResponse.empty({ status: 404 });
  });
};
