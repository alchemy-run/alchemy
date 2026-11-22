import { UrlMissing } from "@alchemy.run/redis";
import * as Render from "@alchemy.run/render";
import { afterAll, describe, expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { type BaseRuntimeContext, RuntimeContext } from "alchemy/RuntimeContext";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { FakeRenderServer } from "./FakeRenderServer.ts";

/**
 * Lightweight local RESP v2 server supporting AUTH, PING, SET, and GET so
 * ReadKeyValue / WriteKeyValue / ReadWriteKeyValue bindings can execute real
 * TCP Redis commands offline.
 */
const startMockRespServer = () => {
  const store = new Map<string, string>();
  let authToken: string | undefined;

  const parseRespCommands = (chunk: string): string[][] => {
    const cmds: string[][] = [];
    let pos = 0;
    while (pos < chunk.length) {
      if (chunk[pos] !== "*") break;
      const lineEnd = chunk.indexOf("\r\n", pos);
      if (lineEnd < 0) break;
      const argc = Number(chunk.slice(pos + 1, lineEnd));
      pos = lineEnd + 2;
      const args: string[] = [];
      for (let i = 0; i < argc; i++) {
        if (chunk[pos] !== "$") break;
        const lenEnd = chunk.indexOf("\r\n", pos);
        const len = Number(chunk.slice(pos + 1, lenEnd));
        pos = lenEnd + 2;
        args.push(chunk.slice(pos, pos + len));
        pos += len + 2;
      }
      cmds.push(args);
    }
    return cmds;
  };

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        const text = Buffer.from(data).toString("utf8");
        const responses: string[] = [];
        for (const args of parseRespCommands(text)) {
          const cmd = (args[0] ?? "").toUpperCase();
          if (cmd === "AUTH") {
            authToken = args[1];
            responses.push("+OK\r\n");
          } else if (cmd === "PING") {
            responses.push(
              args[1] ? `$${Buffer.byteLength(args[1])}\r\n${args[1]}\r\n` : "+PONG\r\n",
            );
          } else if (cmd === "SET") {
            store.set(args[1] ?? "", args[2] ?? "");
            responses.push("+OK\r\n");
          } else if (cmd === "GET") {
            const val = store.get(args[1] ?? "");
            if (val === undefined) {
              responses.push("$-1\r\n");
            } else {
              responses.push(`$${Buffer.byteLength(val)}\r\n${val}\r\n`);
            }
          } else {
            responses.push(`-ERR unknown command '${cmd}'\r\n`);
          }
        }
        if (responses.length > 0) {
          socket.write(responses.join(""));
        }
      },
    },
  });

  return {
    port: server.port,
    get authToken() {
      return authToken;
    },
    stop: () => server.stop(true),
  };
};

const makeMockRuntimeContext = (
  type: string,
  env: Record<string, string | Redacted.Redacted<string>> = {},
) => {
  const stored = new Map<string, unknown>(Object.entries(env));
  const service: BaseRuntimeContext = {
    Type: type,
    id: "mock-host",
    env: Object.fromEntries(Object.entries(env)),
    get: <T>(key: string) => Effect.succeed(stored.get(key) as T | undefined),
    set: (id: string, value: unknown) =>
      Effect.sync(() => {
        stored.set(id, value);
        service.env[id] = value as string | Redacted.Redacted<string>;
        return id;
      }),
  };
  return {
    stored,
    layer: Layer.succeed(RuntimeContext, service),
  };
};

const withRuntimeFlag = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = (globalThis as { __ALCHEMY_RUNTIME__?: boolean }).__ALCHEMY_RUNTIME__;
      (globalThis as { __ALCHEMY_RUNTIME__?: boolean }).__ALCHEMY_RUNTIME__ = true;
      return prev;
    }),
    () => effect,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) {
          delete (globalThis as { __ALCHEMY_RUNTIME__?: boolean }).__ALCHEMY_RUNTIME__;
        } else {
          (globalThis as { __ALCHEMY_RUNTIME__?: boolean }).__ALCHEMY_RUNTIME__ = prev;
        }
      }),
  );

describe(
  "Render Runtime-Colored Bindings (ConnectPostgres & *KeyValue)",
  { tags: ["provider:render", "local"], timeout: 60_000 },
  () => {
    const fake = new FakeRenderServer();
    const resp = startMockRespServer();
    const t = Test.make({ providers: fake.providersLayer() });
    afterAll(() => {
      fake.stop();
      resp.stop();
    });

    t.test.provider(
      "binds Postgres and KeyValue env vars into Render compute services during stack deploy",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const db = yield* Render.Postgres("BoundDb", {
                name: "bound-db",
                plan: "basic_256mb",
              });
              const kv = yield* Render.KeyValue("BoundKv", {
                name: "bound-kv",
                plan: "starter",
              });

              const api = yield* Render.WebService(
                "BoundApi",
                Effect.gen(function* () {
                  yield* Render.ConnectPostgres(db);
                  yield* Render.ReadWriteKeyValue(kv);
                  return {
                    name: "bound-api",
                    plan: "starter",
                    region: "oregon",
                    envVars: {
                      CUSTOM_VAR: "hello",
                    },
                    runtimeSource: {
                      image: { imagePath: "ghcr.io/alchemy/bound-api", tag: "v1" },
                    },
                  };
                }),
              );

              const worker = yield* Render.BackgroundWorker(
                "ReadWorker",
                Effect.gen(function* () {
                  yield* Render.ReadKeyValue(kv);
                  return {
                    name: "read-worker",
                    plan: "starter",
                    region: "oregon",
                    runtimeSource: {
                      image: { imagePath: "ghcr.io/alchemy/read-worker", tag: "v1" },
                    },
                  };
                }),
              );

              const cron = yield* Render.CronJob(
                "WriteCron",
                Effect.gen(function* () {
                  yield* Render.WriteKeyValue(kv);
                  return {
                    name: "write-cron",
                    plan: "starter",
                    region: "oregon",
                    schedule: "0 * * * *",
                    runtimeSource: {
                      image: { imagePath: "ghcr.io/alchemy/write-cron", tag: "v1" },
                    },
                  };
                }),
              );

              return { db, kv, api, worker, cron };
            }),
          );

          const pgKeys = Render.connectPostgresEnvKeys({ LogicalId: "BoundDb" });
          expect(Redacted.value(deployed.api.envVars.CUSTOM_VAR)).toBe("hello");
          expect(Redacted.value(deployed.api.envVars[Render.DATABASE_URL_ENV])).toBe(
            Redacted.value(deployed.db.connectionInfo.internalConnectionString),
          );
          expect(Redacted.value(deployed.api.envVars[pgKeys.internal])).toBe(
            Redacted.value(deployed.db.connectionInfo.internalConnectionString),
          );
          expect(Redacted.value(deployed.api.envVars[pgKeys.external])).toBe(
            Redacted.value(deployed.db.connectionInfo.externalConnectionString),
          );
          expect(Redacted.value(deployed.api.envVars.REDIS_URL)).toBe(
            Redacted.value(deployed.kv.connectionInfo.internalConnectionString),
          );
          expect(Redacted.value(deployed.worker.envVars.REDIS_URL)).toBe(
            Redacted.value(deployed.kv.connectionInfo.internalConnectionString),
          );
          expect(Redacted.value(deployed.cron.envVars.REDIS_URL)).toBe(
            Redacted.value(deployed.kv.connectionInfo.internalConnectionString),
          );

          yield* stack.destroy();
          expect(fake.snapshotCounts().services).toBe(0);
          expect(fake.snapshotCounts().postgres).toBe(0);
          expect(fake.snapshotCounts().keyValues).toBe(0);
        }),
      { tags: ["provider:render", "local"], timeout: 60_000 },
    );

    it.effect(
      "prefers external connection string on non-Render hosts, resolves runtime env, fails cleanly when missing, and runs RESP commands",
      () =>
        Effect.gen(function* () {
          const fakeDb = {
            Type: "Render.Postgres",
            LogicalId: "ExternalDb",
            connectionInfo: {
              internalConnectionString: Redacted.make("postgresql://user:pw@dpg-internal:5432/db"),
              externalConnectionString: Redacted.make(
                "postgresql://user:pw@oregon-postgres.render.com/db",
              ),
            },
          } as unknown as Render.Postgres;

          const fakeKv = {
            Type: "Render.KeyValue",
            LogicalId: "ExternalKv",
            connectionInfo: {
              internalConnectionString: Redacted.make("redis://internal-kv:6379"),
              externalConnectionString: Redacted.make(`redis://:pw@127.0.0.1:${resp.port}`),
            },
          } as unknown as Render.KeyValue;

          const foreignRt = makeMockRuntimeContext("Foreign.Compute");
          const pgKeys = Render.connectPostgresEnvKeys(fakeDb);
          const kvIdKey = "RENDER_KV_EXTERNALKV_EXTERNAL";

          // Foreign host (no Render.WebService.Self): writes external key to RuntimeContext and prefers external URL
          const pgClient = yield* Render.ConnectPostgres(fakeDb).pipe(
            Effect.provide(Render.ConnectPostgresHttp),
            Effect.provide(foreignRt.layer),
          );
          expect(foreignRt.stored.has(pgKeys.external)).toBe(true);

          // Simulate runtime lookup when internal & external are both in RuntimeContext
          const runtimeRt = makeMockRuntimeContext("Foreign.Compute", {
            [pgKeys.internal]: "postgresql://user:pw@dpg-internal:5432/db",
            [pgKeys.external]: "postgresql://user:pw@oregon-postgres.render.com/db",
            [kvIdKey]: `redis://:pw@127.0.0.1:${resp.port}`,
          });

          // Deploy-time KeyValue Read / Write / ReadWrite binding against foreign RuntimeContext
          const kvRw = yield* Render.ReadWriteKeyValue(fakeKv).pipe(
            Effect.provide(Render.ReadWriteKeyValueHttp),
            Effect.provide(foreignRt.layer),
          );
          const kvWrite = yield* Render.WriteKeyValue(fakeKv).pipe(
            Effect.provide(Render.WriteKeyValueHttp),
            Effect.provide(foreignRt.layer),
          );
          const kvRead = yield* Render.ReadKeyValue(fakeKv).pipe(
            Effect.provide(Render.ReadKeyValueHttp),
            Effect.provide(foreignRt.layer),
          );
          expect(foreignRt.stored.has(kvIdKey)).toBe(true);

          // Simulate runtime inside deployed foreign host
          yield* withRuntimeFlag(
            Effect.gen(function* () {
              const preferredUrl = yield* pgClient.connectionString.pipe(
                Effect.provide(runtimeRt.layer),
              );
              expect(Redacted.value(preferredUrl)).toBe(
                "postgresql://user:pw@oregon-postgres.render.com/db",
              );

              // Missing env fails with typed PostgresUrlMissing
              const emptyRt = makeMockRuntimeContext("Foreign.Compute");
              const pgMissing = yield* pgClient.connectionString.pipe(
                Effect.provide(emptyRt.layer),
                Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
                Effect.flip,
              );
              expect(pgMissing).toBeInstanceOf(Render.PostgresUrlMissing);

              const pong = yield* kvRead.ping().pipe(Effect.provide(runtimeRt.layer));
              expect(pong).toBe("PONG");
              yield* kvWrite.set("hello", "render-kv").pipe(Effect.provide(runtimeRt.layer));
              const val = yield* kvRw.get("hello").pipe(Effect.provide(runtimeRt.layer));
              expect(val).toBe("render-kv");

              // Missing Redis env fails with Redis UrlMissing
              const kvMissing = yield* kvRead
                .get("hello")
                .pipe(
                  Effect.provide(emptyRt.layer),
                  Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
                  Effect.flip,
                );
              expect(kvMissing).toBeInstanceOf(UrlMissing);
            }),
          );
        }),
      { tags: ["provider:render", "local"], exclusive: true, timeout: 60_000 },
    );
  },
);
