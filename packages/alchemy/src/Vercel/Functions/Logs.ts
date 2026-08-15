/**
 * `alchemy logs` / `alchemy tail` wiring for {@link Function} (DESIGN §
 * "logs/tail wiring").
 *
 * Platform facts (live-verified, PROBES.md):
 *
 * - `GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs`
 *   is a **live-only hanging NDJSON stream** — it delivers 0 bytes of
 *   historical logs and then emits rows as invocations happen. It is
 *   therefore consumed as a raw `HttpClient` stream (the distilled
 *   `logs.getRuntimeLogs` operation models a request/response exchange and
 *   would hang draining the body), the same way Cloudflare's tail rides a
 *   raw websocket next to its distilled service.
 * - `GET /v3/deployments/{idOrUrl}/events` (distilled
 *   `deployments.getDeploymentEvents`) is the only *historical* log source
 *   the API offers: build/deployment events (stdout/stderr/command lines).
 *
 * So the two provider hooks map as:
 *
 * - **`tail`** — the runtime-logs stream, re-opened when Vercel closes it
 *   (the server ends the response after an idle window), until the caller
 *   interrupts.
 * - **`logs`** — historical build events, plus a short bounded live window
 *   on the runtime-logs stream so invocations happening right now surface
 *   too (the platform keeps no runtime-log history to query).
 */
import { Credentials } from "@distilled.cloud/vercel/Credentials";
import * as deployments from "@distilled.cloud/vercel/deployments";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { LogLine, LogsInput } from "../../Provider.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";

/** Default `logs` page size when the caller passes no `--limit`. */
const DEFAULT_LIMIT = 100;

/**
 * How long a `logs` call keeps the live runtime-logs stream open. The
 * endpoint has no historical delivery at all, so this bounded window is the
 * only way `alchemy logs` can show runtime lines — anything longer trades
 * CLI latency for a bigger capture chance.
 */
const RUNTIME_LOG_WINDOW = "5 seconds";

/** A single NDJSON row of the runtime-logs stream (fields per Vercel docs). */
interface RuntimeLogRow {
  level?: string;
  message?: string;
  source?: string;
  rowId?: string;
  timestampInMs?: number;
  requestMethod?: string;
  requestPath?: string;
  responseStatusCode?: number;
}

/** Render one runtime-log row as a {@link LogLine}, or skip it. */
const runtimeRowToLine = (raw: string): LogLine | undefined => {
  const text = raw.trim();
  if (text.length === 0) return undefined;
  let row: RuntimeLogRow;
  try {
    row = JSON.parse(text) as RuntimeLogRow;
  } catch {
    // Keep-alive / non-JSON noise on the stream.
    return undefined;
  }
  if (typeof row !== "object" || row === null) return undefined;
  const timestamp = new Date(
    typeof row.timestampInMs === "number" ? row.timestampInMs : Date.now(),
  );
  const message = typeof row.message === "string" ? row.message : "";
  if (
    message.length === 0 &&
    typeof row.requestMethod === "string" &&
    typeof row.requestPath === "string"
  ) {
    // Request-summary rows carry no message body.
    const status = row.responseStatusCode ?? "-";
    return {
      timestamp,
      message: `${row.requestMethod} ${row.requestPath} > ${status}`,
    };
  }
  if (message.length === 0) return undefined; // delimiter/heartbeat rows
  const level = row.level ?? "info";
  return {
    timestamp,
    message: level === "info" ? message : `${level}: ${message}`,
  };
};

/** Normalize one deployment (build) event to a {@link LogLine}. */
const buildEventToLine = (event: unknown): LogLine | undefined => {
  if (typeof event !== "object" || event === null) return undefined;
  const item = event as {
    created?: number;
    date?: number;
    text?: string;
    payload?: { text?: string; date?: number; created?: number };
  };
  const text = item.payload?.text ?? item.text;
  if (typeof text !== "string" || text.length === 0) return undefined;
  const ms =
    item.payload?.date ??
    item.date ??
    item.payload?.created ??
    item.created ??
    Date.now();
  return { timestamp: new Date(ms), message: text };
};

export interface FunctionLogsTarget {
  readonly projectId: string;
  /** May be `""` on a never-deployed row (precreate stub) — yields no logs. */
  readonly deploymentId: string;
}

/**
 * Shared log-access clients for the Vercel Function provider — resolved once
 * in the provider's init Effect (mirrors `CloudflareLogs`) and closed over
 * by the `tail`/`logs` hooks.
 */
export const VercelFunctionLogs = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const credentials = yield* Credentials;
  const environment = yield* VercelEnvironment;
  const getDeploymentEvents = yield* deployments.getDeploymentEvents;

  /**
   * Open the live runtime-logs NDJSON stream for one deployment. The
   * response hangs and emits rows as invocations happen; interruption
   * aborts the underlying fetch.
   */
  const openRuntimeStream = (target: FunctionLogsTarget) =>
    Effect.gen(function* () {
      const { token, apiBaseUrl } = yield* credentials;
      const { teamId } = yield* environment;
      const url = new URL(
        `/v1/projects/${target.projectId}/deployments/${target.deploymentId}/runtime-logs`,
        apiBaseUrl,
      );
      if (teamId !== undefined) url.searchParams.set("teamId", teamId);
      const response = yield* client.execute(
        HttpClientRequest.bearerToken(
          HttpClientRequest.get(url.toString()),
          token,
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        return yield* Effect.fail(
          new Error(
            `Vercel runtime-logs stream for deployment ${target.deploymentId} failed with status ${response.status}: ${body.slice(0, 300)}`,
          ),
        );
      }
      return response.stream.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.map(runtimeRowToLine),
        Stream.filter((line): line is LogLine => line !== undefined),
      );
    });

  /** Bounded-retry the connect only — mid-stream failures propagate. */
  const runtimeStream = (target: FunctionLogsTarget) =>
    Stream.unwrap(
      openRuntimeStream(target).pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 3,
        }),
      ),
    );

  /**
   * `alchemy tail`: stream runtime log lines until interrupted. Vercel ends
   * the hanging response after its idle window, so the session is re-opened
   * on clean end (live-only delivery means reconnects never duplicate).
   */
  const tail = (target: FunctionLogsTarget): Stream.Stream<LogLine, unknown> =>
    target.deploymentId === ""
      ? Stream.empty
      : runtimeStream(target).pipe(Stream.repeat(Schedule.spaced("1 second")));

  /**
   * `alchemy logs`: historical build/deployment events, plus whatever the
   * live runtime stream delivers inside a short bounded window (the
   * platform keeps no queryable runtime-log history — PROBES.md).
   */
  const logs = (input: {
    readonly target: FunctionLogsTarget;
    readonly options: LogsInput;
  }): Effect.Effect<LogLine[], unknown> =>
    Effect.gen(function* () {
      if (input.target.deploymentId === "") return [];
      const limit = input.options.limit ?? DEFAULT_LIMIT;
      const { teamId } = yield* environment;

      const events = yield* getDeploymentEvents({
        idOrUrl: input.target.deploymentId,
        teamId,
        builds: 1,
        limit,
        since: input.options.since?.getTime(),
      });
      const buildLines = events.flatMap((event) => {
        const line = buildEventToLine(event);
        return line === undefined ? [] : [line];
      });

      // Best-effort live capture: bounded by the window AND the limit;
      // failures (e.g. a deployment past its log-retention) never mask the
      // build lines above.
      const runtimeLines: LogLine[] = [];
      yield* runtimeStream(input.target).pipe(
        Stream.take(limit),
        Stream.runForEach((line) => Effect.sync(() => runtimeLines.push(line))),
        Effect.timeoutOption(RUNTIME_LOG_WINDOW),
        Effect.ignore,
      );

      return [...buildLines, ...runtimeLines]
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
        .slice(-limit);
    });

  return { tail, logs };
});
