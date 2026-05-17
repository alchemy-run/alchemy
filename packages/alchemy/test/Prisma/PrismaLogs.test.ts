import type { PrismaManagementClient } from "@/Prisma/Client";
import {
  parseComputeLogRecord,
  tailComputeVersionLogs,
} from "@/Prisma/PrismaLogs";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { WebSocketServer } from "ws";

describe("Prisma compute logs", () => {
  it.effect("decodes compute log records into Alchemy log lines", () =>
    Effect.gen(function* () {
      const timestamp = new Date("2026-01-01T00:00:00.000Z");
      const record = yield* parseComputeLogRecord(
        JSON.stringify({
          type: "log",
          text: "server started",
          byteStart: 0,
          byteEnd: 15,
        }),
        timestamp,
      );

      expect(record).toMatchObject({
        _tag: "log",
        line: { timestamp, message: "server started" },
        raw: { byteStart: 0, byteEnd: 15 },
      });
    }),
  );

  it.effect("decodes terminal records", () =>
    Effect.gen(function* () {
      const record = yield* parseComputeLogRecord(
        JSON.stringify({
          type: "terminal",
          kind: "end",
          code: "segment_time_limit",
          message: "segment ended",
          retryable: true,
          cursor: "42",
        }),
        new Date("2026-01-01T00:00:00.000Z"),
      );

      expect(record).toEqual({
        _tag: "terminal",
        raw: {
          type: "terminal",
          kind: "end",
          code: "segment_time_limit",
          message: "segment ended",
          retryable: true,
          cursor: "42",
        },
      });
    }),
  );

  it.effect("fails malformed records", () =>
    Effect.gen(function* () {
      const exit = yield* parseComputeLogRecord(
        JSON.stringify({ type: "wat" }),
        new Date("2026-01-01T00:00:00.000Z"),
      ).pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("streams log lines from Prisma's WebSocket endpoint", () =>
    withWebSocketServer((server) =>
      Effect.gen(function* () {
        const url = yield* listenUrl(server);
        let authorization: string | undefined;

        server.on("connection", (socket, request) => {
          authorization = request.headers.authorization;
          socket.send(
            JSON.stringify({
              type: "log",
              text: "first",
              byteStart: 0,
              byteEnd: 5,
            }),
          );
          socket.send(
            JSON.stringify({
              type: "log",
              text: "second",
              byteStart: 6,
              byteEnd: 12,
            }),
          );
          socket.send(
            JSON.stringify({
              type: "terminal",
              kind: "end",
              code: "vm_stopped",
              message: "done",
              retryable: false,
              cursor: null,
            }),
          );
        });

        const client = {
          getComputeVersionLogsRequest: (
            versionId: string,
            query: { tail?: number } | undefined,
          ) =>
            Effect.succeed({
              url: `${url}/v1/compute-services/versions/${versionId}/logs?tail=${query?.tail}`,
              headers: {
                Authorization: Redacted.make("Bearer test-token"),
              },
            }),
        } as unknown as PrismaManagementClient;

        const lines = yield* tailComputeVersionLogs(client, "version-1", {
          tail: 2,
        }).pipe(Stream.runCollect);

        expect(lines.map((line) => line.message)).toEqual(["first", "second"]);
        expect(authorization).toBe("Bearer test-token");
      }),
    ),
  );
});

const withWebSocketServer = <A, E, R>(
  f: (server: WebSocketServer) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new WebSocketServer({ host: "127.0.0.1", port: 0 })),
    f,
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }).pipe(Effect.ignore),
  );

const listenUrl = (server: WebSocketServer) =>
  Effect.callback<string, Error>((resume) => {
    const complete = () => {
      cleanup();
      const address = server.address();
      if (address && typeof address === "object") {
        resume(Effect.succeed(`ws://127.0.0.1:${address.port}`));
      } else {
        resume(Effect.fail(new Error("WebSocket server has no TCP address")));
      }
    };
    const fail = (cause: unknown) => {
      cleanup();
      resume(
        Effect.fail(cause instanceof Error ? cause : new Error(String(cause))),
      );
    };
    const cleanup = () => {
      server.off("listening", complete);
      server.off("error", fail);
    };

    if (server.address()) {
      complete();
      return;
    }

    server.once("listening", complete);
    server.once("error", fail);
    return Effect.sync(cleanup);
  });
