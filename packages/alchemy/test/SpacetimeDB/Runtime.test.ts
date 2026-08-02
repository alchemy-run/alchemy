import {
  makeConnectionLayer,
  Connection,
  SpacetimeDBConnectionError,
  type DbConnectionFactory,
  type Disconnectable,
} from "@/SpacetimeDB/Runtime.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

interface FakeConn extends Disconnectable {
  readonly id: string;
  disconnected: boolean;
}

const fakeFactory = (
  behavior: "ok" | "error" | "hang",
  expectedName: string,
): DbConnectionFactory<FakeConn> => ({
  builder: () => {
    const state = {
      uri: "",
      name: "",
      token: undefined as string | undefined,
      onConnect: undefined as
        | ((c: FakeConn, i: unknown, t: string) => void)
        | undefined,
      onError: undefined as ((ctx: unknown, e: Error) => void) | undefined,
    };
    const builder = {
      withUri(uri: string) {
        state.uri = uri;
        return builder;
      },
      withDatabaseName(name: string) {
        state.name = name;
        return builder;
      },
      withToken(token?: string) {
        state.token = token;
        return builder;
      },
      onConnect(cb: (c: FakeConn, i: unknown, t: string) => void) {
        state.onConnect = cb;
        return builder;
      },
      onConnectError(cb: (ctx: unknown, e: Error) => void) {
        state.onError = cb;
        return builder;
      },
      build(): FakeConn {
        const conn: FakeConn = {
          id: `${expectedName}|${state.uri}|${state.name}|${state.token ?? ""}`,
          disconnected: false,
          disconnect() {
            conn.disconnected = true;
          },
        };
        queueMicrotask(() => {
          if (behavior === "ok") {
            state.onConnect?.(conn, { hex: "abc" }, "tok");
          } else if (behavior === "error") {
            state.onError?.(null, new Error("boom"));
          }
        });
        return conn;
      },
    };
    return builder;
  },
});

describe("makeConnectionLayer", () => {
  it.effect("opens a connection and disconnects on scope close", () =>
    Effect.gen(function* () {
      const layer = makeConnectionLayer(fakeFactory("ok", "todos"), {
        name: "todos",
        uri: "ws://localhost:3000",
        databaseName: "todos",
        token: "t",
      });
      const conn = yield* Effect.scoped(
        Effect.gen(function* () {
          const c = yield* Connection<FakeConn>("todos");
          expect(c.id).toBe("todos|ws://localhost:3000|todos|t");
          expect(c.disconnected).toBe(false);
          return c;
        }).pipe(Effect.provide(layer)),
      );
      expect(conn.disconnected).toBe(true);
    }),
  );

  it.effect("fails when onConnectError fires", () =>
    Effect.gen(function* () {
      const layer = makeConnectionLayer(fakeFactory("error", "todos"), {
        name: "todos",
        uri: "ws://localhost:3000",
        databaseName: "todos",
      });
      const result = yield* Effect.result(
        Effect.scoped(
          Effect.gen(function* () {
            return yield* Connection<FakeConn>("todos");
          }).pipe(Effect.provide(layer)),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(SpacetimeDBConnectionError);
      }
    }),
  );

  it.live("times out when connect never completes", () =>
    Effect.gen(function* () {
      const layer = makeConnectionLayer(fakeFactory("hang", "todos"), {
        name: "todos",
        uri: "ws://localhost:3000",
        databaseName: "todos",
        connectTimeout: "50 millis",
      });
      const result = yield* Effect.result(
        Effect.scoped(
          Effect.gen(function* () {
            return yield* Connection<FakeConn>("todos");
          }).pipe(Effect.provide(layer)),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("timed out");
      }
    }),
  );

  it.effect("two named connections coexist in one context", () =>
    Effect.gen(function* () {
      const a = makeConnectionLayer(fakeFactory("ok", "a"), {
        name: "a",
        uri: "ws://a",
        databaseName: "a-db",
      });
      const b = makeConnectionLayer(fakeFactory("ok", "b"), {
        name: "b",
        uri: "ws://b",
        databaseName: "b-db",
      });
      const [connA, connB] = yield* Effect.scoped(
        Effect.all([Connection<FakeConn>("a"), Connection<FakeConn>("b")]).pipe(
          Effect.provide(Layer.mergeAll(a, b)),
        ),
      );
      expect(connA.id).toContain("a-db");
      expect(connB.id).toContain("b-db");
    }),
  );
});
