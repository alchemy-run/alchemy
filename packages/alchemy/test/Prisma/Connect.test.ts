import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Output from "@/Output";
import { Compute as PrismaCompute } from "@/Prisma/Compute";
import { Connect, ConnectBinding, connectEnvKeys } from "@/Prisma/Connect";
import type { Connection as PrismaConnection } from "@/Prisma/Connection";
import { Providers as PrismaProviderCollection } from "@/Prisma/Providers";
import { RuntimeContext } from "@/RuntimeContext";
import { Self } from "@/Self";
import { Stack, type StackSpec } from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState } from "@/State/InMemoryState";

/**
 * `Connect` / `Connection.bind` binding tests. They exercise the binding
 * layer against a stubbed host and runtime and never call a provider
 * lifecycle method, so they stay unit tests.
 */

const redactedValue = (value: string | Redacted.Redacted<string> | undefined) => {
  if (!Redacted.isRedacted(value)) {
    throw new Error("Expected a redacted value");
  }
  return Redacted.value(value);
};

describe("Prisma Connect bindings", { tags: ["unit", "provider:prisma", "local"] }, () => {
  it(
    "derives namespaced-safe env keys for connection bindings",
    () => {
      expect(
        connectEnvKeys({ FQN: "Connection", LogicalId: "Connection" }).directConnectionString,
      ).toBe("PRISMA_CONNECTION_DIRECT_CONNECTION_STRING");
      expect(
        connectEnvKeys({ FQN: "Api/Connection", LogicalId: "Connection" }).directConnectionString,
      ).toBe("PRISMA_API_CONNECTION_DIRECT_CONNECTION_STRING");
    },
    { tags: ["provider:prisma:connect"] },
  );

  it.effect(
    "ConnectBinding resolves bound connection outputs at runtime",
    () => {
      const stored: Record<string, Output.Output> = {};
      let capturedBindingEnv: Record<string, Output.Output> | undefined;
      const runtime = {
        Type: "Prisma.Compute",
        id: "App",
        env: stored,
        set: (id: string, output: Output.Output) =>
          Effect.sync(() => {
            const key = id.replaceAll(/[^a-zA-Z0-9]/g, "_");
            stored[key] = output;
            return key;
          }),
        get: <T>(key: string): Effect.Effect<T> => {
          const output = stored[key];
          if (!output) return Effect.die(`missing runtime binding ${key}`);
          return Output.evaluate(output, {}) as Effect.Effect<T>;
        },
      };
      const host = {
        Type: "Prisma.Compute",
        LogicalId: "App",
        FQN: "App",
        bind: (...args: unknown[]) =>
          args[0] instanceof Array
            ? (binding: { env?: Record<string, Output.Output> }) =>
                Effect.sync(() => {
                  capturedBindingEnv = binding.env;
                })
            : Effect.void,
      };
      const escapedPooledConnectionString = "__ALCHEMY_PRISMA_CONNECTION_VALUE__:prisma://pooled";
      const connection = {
        Type: "Prisma.Connection",
        LogicalId: "Connection",
        FQN: "Api/Connection",
        connectionId: Output.asOutput("connection-1"),
        databaseId: Output.asOutput("database-1"),
        directConnectionString: Output.asOutput(Redacted.make("postgres://direct")),
        pooledConnectionString: Output.asOutput(Redacted.make(escapedPooledConnectionString)),
        accelerateConnectionString: Output.asOutput(undefined),
        host: Output.asOutput("db.example.test"),
        user: Output.asOutput(null),
        password: Output.asOutput(Redacted.make("password")),
      } as PrismaConnection;

      return Effect.gen(function* () {
        const db = yield* Connect(connection);
        const keys = connectEnvKeys(connection);
        const encodedEnv = yield* Output.evaluate(capturedBindingEnv ?? {}, {}) as Effect.Effect<
          Record<string, unknown>
        >;

        expect(Object.keys(stored)).toEqual([]);
        expect(encodedEnv[keys.accelerateConnectionString]).toEqual(expect.any(String));
        expect(encodedEnv[keys.user]).toEqual(expect.any(String));
        expect(yield* db.connectionId).toBe("connection-1");
        expect(Redacted.value(yield* db.databaseUrl)).toBe(escapedPooledConnectionString);
        expect(Redacted.value((yield* db.directConnectionString)!)).toBe("postgres://direct");
        expect(Redacted.value((yield* db.pooledConnectionString)!)).toBe(
          escapedPooledConnectionString,
        );
        expect(yield* db.accelerateConnectionString).toBeUndefined();
        expect(yield* db.user).toBeNull();
        expect(Redacted.value((yield* db.password)!)).toBe("password");
        expect(Object.keys(stored)).toEqual(
          expect.arrayContaining([
            "PRISMA_API_CONNECTION_CONNECTION_ID",
            "PRISMA_API_CONNECTION_DIRECT_CONNECTION_STRING",
            "PRISMA_API_CONNECTION_POOLED_CONNECTION_STRING",
            "PRISMA_API_CONNECTION_ACCELERATE_CONNECTION_STRING",
            "PRISMA_API_CONNECTION_USER",
            "PRISMA_API_CONNECTION_PASSWORD",
          ]),
        );
      }).pipe(
        Effect.provide(ConnectBinding),
        Effect.provide(Layer.succeed(RuntimeContext, runtime)),
        Effect.provide(Layer.succeed(Self, host)),
        Effect.provide(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
          ),
        ),
      );
    },
    { tags: ["provider:prisma:connect", "provider:prisma:connection"] },
  );

  it.effect(
    "ConnectBinding does not require the deploy-time host at runtime",
    () => {
      const stored: Record<string, Output.Output> = {};
      const runtime = {
        Type: "Prisma.Compute",
        id: "App",
        env: stored,
        set: (id: string, output: Output.Output) =>
          Effect.sync(() => {
            const key = id.replaceAll(/[^a-zA-Z0-9]/g, "_");
            stored[key] = output;
            return key;
          }),
        get: <T>(key: string): Effect.Effect<T> => {
          const output = stored[key];
          if (!output) return Effect.die(`missing runtime binding ${key}`);
          return Output.evaluate(output, {}) as Effect.Effect<T>;
        },
      };
      const connection = {
        Type: "Prisma.Connection",
        LogicalId: "Connection",
        FQN: "Connection",
        connectionId: Output.asOutput("connection-1"),
        databaseId: Output.asOutput("database-1"),
        directConnectionString: Output.asOutput(Redacted.make("postgres://runtime")),
        pooledConnectionString: Output.asOutput(undefined),
        accelerateConnectionString: Output.asOutput(undefined),
        host: Output.asOutput("db.example.test"),
        user: Output.asOutput("api"),
        password: Output.asOutput(Redacted.make("password")),
      } as PrismaConnection;

      // The deploy-time host dispatch is guarded by `__ALCHEMY_RUNTIME__`,
      // which bundles fold to `true` — simulate that so no Self is needed.
      const wasRuntime = globalThis.__ALCHEMY_RUNTIME__;
      globalThis.__ALCHEMY_RUNTIME__ = true;
      return Effect.gen(function* () {
        const db = yield* Connect(connection);

        expect(yield* db.connectionId).toBe("connection-1");
        expect(Redacted.value(yield* db.databaseUrl)).toBe("postgres://runtime");
      }).pipe(
        Effect.provide(ConnectBinding),
        Effect.provide(Layer.succeed(RuntimeContext, runtime)),
        Effect.provide(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            globalThis.__ALCHEMY_RUNTIME__ = wasRuntime;
          }),
        ),
      );
    },
    { tags: ["provider:prisma:connect", "provider:prisma:connection"] },
  );

  it.effect(
    "Prisma.Compute records Connection.bind env on platform bindings",
    () => {
      const stack: Omit<StackSpec, "output"> = {
        name: "prisma-compute-binding-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      };
      const connection = {
        Type: "Prisma.Connection",
        LogicalId: "Connection",
        FQN: "Api/Connection",
        connectionId: Output.asOutput("connection-1"),
        databaseId: Output.asOutput("database-1"),
        directConnectionString: Output.asOutput(Redacted.make("postgres://api")),
        pooledConnectionString: Output.asOutput(Redacted.make("prisma+postgres://api")),
        accelerateConnectionString: Output.asOutput(undefined),
        host: Output.asOutput("db.example.test"),
        user: Output.asOutput("api"),
        password: Output.asOutput(Redacted.make("password")),
      } as PrismaConnection;

      return Effect.gen(function* () {
        const app = yield* PrismaCompute(
          "App",
          { project: "project-1", appName: "api", main: "app.ts" },
          Effect.gen(function* () {
            yield* Connect(connection);
          }).pipe(Effect.provide(ConnectBinding)),
        );

        const keys = connectEnvKeys(connection);
        const binding = stack.bindings[app.FQN]?.[0];
        const env = yield* Output.evaluate(binding?.data.env ?? {}, {});

        expect(binding?.sid).toBe("Connection");
        expect(Object.keys(env)).toEqual(
          expect.arrayContaining([
            keys.connectionId,
            keys.databaseId,
            keys.directConnectionString,
            keys.pooledConnectionString,
            keys.password,
          ]),
        );
        expect(env[keys.connectionId]).toBe("connection-1");
        expect(env[keys.databaseId]).toBe("database-1");
        expect(redactedValue(env[keys.directConnectionString] ?? undefined)).toBe("postgres://api");
        expect(redactedValue(env[keys.pooledConnectionString] ?? undefined)).toBe(
          "prisma+postgres://api",
        );
        expect(redactedValue(env[keys.password] ?? undefined)).toBe("password");
      }).pipe(
        Effect.provide(inMemoryState()),
        Effect.provide(
          Layer.succeed(PrismaProviderCollection, {
            kind: "ProviderCollection" as const,
            get: () => undefined,
            providers: {},
          }),
        ),
        Effect.provideService(Stack, stack),
        Effect.provideService(Stage, "test"),
        Effect.provide(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "plan" }),
          ),
        ),
      );
    },
    { tags: ["provider:prisma:compute", "provider:prisma:connect", "provider:prisma:connection"] },
  );

  it.effect(
    "Connection.bind records env for AWS Lambda function hosts",
    () => {
      const stored: Record<string, Output.Output> = {};
      let capturedBindingEnv: Record<string, Output.Output> | undefined;
      const runtime = {
        Type: "AWS.Lambda.Function",
        id: "Api",
        env: stored,
        set: (id: string, output: Output.Output) =>
          Effect.sync(() => {
            const key = id.replaceAll(/[^a-zA-Z0-9]/g, "_");
            stored[key] = output;
            return key;
          }),
        get: <T>(key: string): Effect.Effect<T> => {
          const output = stored[key];
          if (!output) return Effect.die(`missing runtime binding ${key}`);
          return Output.evaluate(output, {}) as Effect.Effect<T>;
        },
      };
      const host = {
        Type: "AWS.Lambda.Function",
        LogicalId: "Api",
        FQN: "Api",
        bind: (...args: unknown[]) =>
          args[0] instanceof Array
            ? (binding: { env?: Record<string, Output.Output> }) =>
                Effect.sync(() => {
                  capturedBindingEnv = binding.env;
                })
            : Effect.void,
      };
      const connection = {
        Type: "Prisma.Connection",
        LogicalId: "Connection",
        FQN: "Connection",
        connectionId: Output.asOutput("connection-1"),
        databaseId: Output.asOutput("database-1"),
        directConnectionString: Output.asOutput(Redacted.make("postgres://api")),
        pooledConnectionString: Output.asOutput(undefined),
        accelerateConnectionString: Output.asOutput(undefined),
        host: Output.asOutput("db.example.test"),
        user: Output.asOutput("api"),
        password: Output.asOutput(Redacted.make("password")),
      } as PrismaConnection;

      return Effect.gen(function* () {
        const db = yield* Connect(connection);
        const keys = connectEnvKeys(connection);
        const env = yield* Output.evaluate(capturedBindingEnv ?? {}, {}) as Effect.Effect<
          Record<string, unknown>
        >;

        expect(Object.keys(env)).toEqual(
          expect.arrayContaining([
            keys.connectionId,
            keys.databaseId,
            keys.directConnectionString,
            keys.password,
          ]),
        );
        expect(env[keys.connectionId]).toBe("connection-1");
        expect(env[keys.databaseId]).toBe("database-1");
        expect(
          redactedValue(
            env[keys.directConnectionString] as string | Redacted.Redacted<string> | undefined,
          ),
        ).toBe("postgres://api");
        expect(
          redactedValue(env[keys.password] as string | Redacted.Redacted<string> | undefined),
        ).toBe("password");
        expect(Redacted.value(yield* db.databaseUrl)).toBe("postgres://api");
      }).pipe(
        Effect.provide(ConnectBinding),
        Effect.provide(inMemoryState()),
        Effect.provide(Layer.succeed(RuntimeContext, runtime)),
        Effect.provide(Layer.succeed(Self, host)),
        Effect.provide(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
          ),
        ),
      );
    },
    { tags: ["provider:prisma:connect", "provider:prisma:connection"] },
  );

  it.effect(
    "Connection.bind records native text bindings for Workers",
    () => {
      const workerEnv: Record<string, string> = {};
      let capturedBindings: unknown[] | undefined;
      const runtime = {
        Type: "Cloudflare.Worker",
        id: "Worker",
        env: {},
        set: (id: string) => Effect.succeed(id.replaceAll(/[^a-zA-Z0-9]/g, "_")),
        get: <T>(key: string): Effect.Effect<T> => {
          const value = workerEnv[key];
          if (value === undefined) {
            return Effect.die(`missing worker binding ${key}`);
          }
          return Effect.succeed(value as T);
        },
      };
      const host = {
        Type: "Cloudflare.Worker",
        LogicalId: "Worker",
        FQN: "Worker",
        bind: (...args: unknown[]) =>
          args[0] instanceof Array
            ? (binding: {
                bindings?: Output.Output<{ type: string; name: string; text: string }>[];
              }) =>
                Effect.sync(() => {
                  capturedBindings = binding.bindings;
                })
            : Effect.void,
      };
      const connection = {
        Type: "Prisma.Connection",
        LogicalId: "Connection",
        FQN: "Connection",
        connectionId: Output.asOutput("connection-1"),
        databaseId: Output.asOutput("database-1"),
        directConnectionString: Output.asOutput(Redacted.make("postgres://api")),
        pooledConnectionString: Output.asOutput(undefined),
        accelerateConnectionString: Output.asOutput(undefined),
        host: Output.asOutput("db.example.test"),
        user: Output.asOutput("api"),
        password: Output.asOutput(Redacted.make("password")),
      } as PrismaConnection;

      return Effect.gen(function* () {
        const db = yield* Connect(connection);
        const keys = connectEnvKeys(connection);
        const bindings = (yield* Output.evaluate(capturedBindings ?? [], {})) as Array<{
          type: string;
          name: string;
          text: string;
        }>;

        for (const binding of bindings) {
          workerEnv[binding.name] = binding.text;
        }

        expect(bindings).toEqual(
          expect.arrayContaining([
            { type: "plain_text", name: keys.connectionId, text: "connection-1" },
            { type: "plain_text", name: keys.databaseId, text: "database-1" },
            { type: "secret_text", name: keys.directConnectionString, text: "postgres://api" },
            { type: "secret_text", name: keys.password, text: "password" },
          ]),
        );
        expect("connectionString" in db).toBe(false);
        expect(Redacted.value(yield* db.databaseUrl)).toBe("postgres://api");
        expect(Redacted.value((yield* db.password)!)).toBe("password");
      }).pipe(
        Effect.provide(ConnectBinding),
        Effect.provide(inMemoryState()),
        Effect.provide(Layer.succeed(RuntimeContext, runtime)),
        Effect.provide(Layer.succeed(Self, host)),
        Effect.provide(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
          ),
        ),
      );
    },
    { tags: ["provider:prisma:connect", "provider:prisma:connection"] },
  );
});
