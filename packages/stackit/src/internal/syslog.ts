/**
 * A syslog client for STACKIT LogMe's ingest: one socket per call, so nothing outlives a
 * request on a host like workerd. Syslog is no HTTP API, so no distilled module applies.
 *
 * Messages are RFC 5424, framed by a newline (RFC 6587's non-transparent framing), which
 * is Fluentd's default for its syslog input. Not exported from any namespace barrel.
 */
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

/** How long a connection and its write can take. */
const SEND_TIMEOUT = "10 seconds";

/** The credential has no syslog drain URL. */
export class SyslogDrainMissing extends Data.TaggedError("Stackit.LogMe.SyslogDrainMissing")<{
  readonly message: string;
}> {}

/** The drain URL's scheme or shape isn't one this client can send to. */
export class SyslogDrainUnsupported extends Data.TaggedError(
  "Stackit.LogMe.SyslogDrainUnsupported",
)<{
  readonly scheme: string | undefined;
  readonly message: string;
}> {}

/** The socket failed or timed out. The URL can hold a password, so it isn't quoted. */
export class SyslogWriteFailed extends Data.TaggedError("Stackit.LogMe.SyslogWriteFailed")<{
  readonly message: string;
}> {}

export type SyslogError = SyslogDrainMissing | SyslogDrainUnsupported | SyslogWriteFailed;

/** A log line, or a message with its syslog fields. */
export type SyslogEntry =
  | string
  | {
      /** The message. Newlines become spaces, because a newline ends a message. */
      readonly message: string;
      /**
       * RFC 5424 severity, from 0 (emergency) to 7 (debug).
       *
       * @default 6
       */
      readonly severity?: number;
      /**
       * RFC 5424 facility, from 0 to 23.
       *
       * @default 1
       */
      readonly facility?: number;
      /**
       * Name of the application.
       *
       * @default "-"
       */
      readonly appName?: string;
      /**
       * Name of the machine.
       *
       * @default "-"
       */
      readonly hostname?: string;
    };

export interface SyslogEndpoint {
  readonly hostname: string;
  readonly port: number;
  readonly tls: boolean;
}

const SCHEMES: Readonly<Record<string, boolean>> = {
  "syslog:": false,
  "tcp:": false,
  "syslog-tls:": true,
  "tls:": true,
};

/** Where a drain URL points; `undefined` for a URL this client can't send to. */
export const parseSyslogDrain = (url: string): SyslogEndpoint | undefined => {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  const tls = SCHEMES[parsed.protocol];
  const port = Number(parsed.port);
  if (tls === undefined || parsed.hostname === "" || !Number.isInteger(port) || port <= 0) {
    return undefined;
  }
  return { hostname: parsed.hostname, port, tls };
};

const field = (value: string | undefined) =>
  value === undefined || value === "" ? "-" : value.replace(/\s+/g, "_");

/** One RFC 5424 message with its trailing newline. */
export const formatSyslogLine = (entry: SyslogEntry, timestamp: string): string => {
  const { message, severity, facility, appName, hostname } =
    typeof entry === "string"
      ? {
          message: entry,
          severity: undefined,
          facility: undefined,
          appName: undefined,
          hostname: undefined,
        }
      : entry;
  const priority = (facility ?? 1) * 8 + (severity ?? 6);
  const text = message.replace(/\r?\n/g, " ");
  return `<${priority}>1 ${timestamp} ${field(hostname)} ${field(appName)} - - - ${text}\n`;
};

interface NodeSocket {
  end(data: string, callback: () => void): unknown;
  destroy(): unknown;
  on(event: string, listener: (cause?: unknown) => void): unknown;
}

const writeFailed = (cause: unknown) =>
  new SyslogWriteFailed({
    message: `Writing to the syslog drain failed: ${
      cause instanceof Error ? cause.message : "the socket reported an error"
    }`,
  });

const connect = (endpoint: SyslogEndpoint) =>
  Effect.tryPromise({
    try: (): Promise<{ readonly socket: NodeSocket; readonly ready: string }> =>
      endpoint.tls
        ? import("node:tls").then((tls) => ({
            socket: tls.connect({
              host: endpoint.hostname,
              port: endpoint.port,
              servername: endpoint.hostname,
            }),
            ready: "secureConnect",
          }))
        : import("node:net").then((net) => ({
            socket: net.connect({ host: endpoint.hostname, port: endpoint.port }),
            ready: "connect",
          })),
    catch: writeFailed,
  });

/** Write `payload` and close: the socket's `end` flushes it first. */
const write = (socket: NodeSocket, ready: string, payload: string) =>
  Effect.callback<void, SyslogWriteFailed>((resume) => {
    socket.on("error", (cause) => resume(Effect.fail(writeFailed(cause))));
    socket.on(ready, () => {
      socket.end(payload, () => resume(Effect.void));
    });
    return Effect.sync(() => {
      socket.destroy();
    });
  });

/** Send entries to a drain URL. `drain` stays out of every error. */
export const sendSyslog = (
  drain: string | Redacted.Redacted<string>,
  entries: SyslogEntry | ReadonlyArray<SyslogEntry>,
): Effect.Effect<void, SyslogError> =>
  Effect.gen(function* () {
    const url = Redacted.isRedacted(drain) ? Redacted.value(drain) : drain;
    const endpoint = parseSyslogDrain(url);
    if (endpoint === undefined) {
      return yield* new SyslogDrainUnsupported({
        scheme: URL.canParse(url) ? new URL(url).protocol : undefined,
        message:
          "The syslog drain URL isn't a `syslog://`, `tcp://`, `syslog-tls://` or `tls://` URL with a port.",
      });
    }
    const now = yield* DateTime.now;
    const timestamp = DateTime.formatIso(now);
    const list = typeof entries === "string" || !Array.isArray(entries) ? [entries] : entries;
    const payload = (list as ReadonlyArray<SyslogEntry>)
      .map((entry) => formatSyslogLine(entry, timestamp))
      .join("");
    const sent = yield* connect(endpoint).pipe(
      Effect.flatMap(({ socket, ready }) => write(socket, ready, payload)),
      Effect.timeoutOption(SEND_TIMEOUT),
    );
    if (Option.isNone(sent)) {
      return yield* new SyslogWriteFailed({
        message: `Writing to the syslog drain timed out after ${SEND_TIMEOUT}.`,
      });
    }
  });
