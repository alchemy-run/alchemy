import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import type WebSocket from "ws";
import type { RawData } from "ws";
import type { LogLine } from "../Provider.ts";
import type { PrismaManagementClient } from "./Client.ts";
import type { ComputeVersionLogsQuery } from "./Types.ts";

export class PrismaLogStreamError extends Data.TaggedError(
  "PrismaLogStreamError",
)<{
  message: string;
  cause?: unknown;
}> {}

interface PrismaComputeLogLine {
  type: "log";
  text: string;
  byteStart: number;
  byteEnd: number;
}

interface PrismaComputeTerminalLine {
  type: "terminal";
  kind: "end" | "error";
  code: string;
  message: string;
  retryable: boolean;
  cursor: string | null;
  details?: Record<string, unknown>;
}

export type PrismaComputeLogRecord =
  | PrismaComputeLogLine
  | PrismaComputeTerminalLine;

export type ParsedComputeLogRecord =
  | { _tag: "log"; line: LogLine; raw: PrismaComputeLogLine }
  | { _tag: "terminal"; raw: PrismaComputeTerminalLine };

export const parseComputeLogRecord = (
  message: string,
  timestamp: Date,
): Effect.Effect<ParsedComputeLogRecord, PrismaLogStreamError> =>
  Effect.try({
    try: () => {
      const raw = JSON.parse(message) as Partial<PrismaComputeLogRecord>;
      if (raw.type === "log" && typeof raw.text === "string") {
        return {
          _tag: "log" as const,
          line: { timestamp, message: raw.text },
          raw: raw as PrismaComputeLogLine,
        };
      }
      if (raw.type === "terminal" && typeof raw.message === "string") {
        return {
          _tag: "terminal" as const,
          raw: raw as PrismaComputeTerminalLine,
        };
      }
      throw new Error(`Unknown Prisma compute log record: ${message}`);
    },
    catch: (cause) =>
      new PrismaLogStreamError({
        message: "Failed to decode Prisma compute log record",
        cause,
      }),
  });

export const tailComputeVersionLogs = (
  client: PrismaManagementClient,
  versionId: string,
  query?: ComputeVersionLogsQuery,
) =>
  Stream.callback<LogLine, PrismaLogStreamError>((queue) =>
    Effect.gen(function* () {
      const request = yield* client.getComputeVersionLogsRequest(
        versionId,
        query,
      );
      const auth = Redacted.value(request.headers.Authorization);
      const WebSocket = yield* loadWebSocketConstructor;
      const socket = yield* Effect.sync(
        () =>
          new WebSocket(request.url, {
            headers: { Authorization: auth },
          }),
      );

      const end = () => Queue.endUnsafe(queue);
      socket.on("message", (raw) => {
        const decoded = Effect.runSyncExit(
          parseComputeLogRecord(rawDataToString(raw), new Date()),
        );
        if (!Exit.isSuccess(decoded)) {
          Queue.failCauseUnsafe(queue, decoded.cause);
          socket.close(1000, "decode failed");
          return;
        }
        const record = decoded.value;
        if (record._tag === "log") {
          Queue.offerUnsafe(queue, record.line);
          return;
        }
        if (record.raw.kind === "error") {
          Queue.offerUnsafe(queue, {
            timestamp: new Date(),
            message: `${record.raw.code}: ${record.raw.message}`,
          });
        }
        end();
        socket.close(1000, "terminal record received");
      });
      socket.on("error", (cause) => {
        Queue.failCauseUnsafe(
          queue,
          Cause.fail(
            new PrismaLogStreamError({
              message: "Prisma compute log WebSocket failed",
              cause,
            }),
          ),
        );
      });
      socket.on("close", end);

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (
            socket.readyState === WebSocket.CONNECTING ||
            socket.readyState === WebSocket.OPEN
          ) {
            socket.close(1000, "tail stopped");
          }
        }),
      );
    }),
  );

const loadWebSocketConstructor = Effect.tryPromise({
  try: () => import("ws").then((module) => module.default),
  catch: (cause) =>
    new PrismaLogStreamError({
      message: "Prisma compute log tailing requires the optional `ws` package.",
      cause,
    }),
});

const rawDataToString = (raw: RawData): string => {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  if (Array.isArray(raw)) return raw.map(rawDataToString).join("");
  return raw.toString("utf8");
};
