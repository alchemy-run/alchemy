import { Branch as PrismaBranch, BranchProvider } from "@/Prisma/Branch";
import { PrismaApiError, PrismaClient } from "@/Prisma/Client";
import { Compute as PrismaCompute } from "@/Prisma/Compute";
import {
  ComputeService as PrismaComputeService,
  ComputeServiceProvider,
} from "@/Prisma/ComputeService";
import {
  ComputeVersion as PrismaComputeVersion,
  ComputeVersionProvider,
} from "@/Prisma/ComputeVersion";
import {
  ConnectionBinding,
  ConnectionBindingLive,
  Connection as PrismaConnection,
  ConnectionProvider,
  connectionBindingEnvKeys,
  connectionEnv,
  connectionUrl,
} from "@/Prisma/Connection";
import {
  CustomDomain as PrismaCustomDomain,
  CustomDomainProvider,
} from "@/Prisma/CustomDomain";
import {
  Database as PrismaDatabase,
  DatabaseProvider,
} from "@/Prisma/Database";
import {
  EnvironmentVariable as PrismaEnvironmentVariable,
  EnvironmentVariableProvider,
} from "@/Prisma/EnvironmentVariable";
import { Project as PrismaProject, ProjectProvider } from "@/Prisma/Project";
import { Providers as PrismaProviderCollection } from "@/Prisma/Providers";
import {
  SourceRepository as PrismaSourceRepository,
  SourceRepositoryProvider,
} from "@/Prisma/SourceRepository";
import * as Output from "@/Output";
import type { PrismaManagementClient } from "@/Prisma/Client";
import { RuntimeContext } from "@/RuntimeContext";
import { Self } from "@/Self";
import { Stack, type StackSpec } from "@/Stack";
import { inMemoryState } from "@/State/InMemoryState";
import { Stage } from "@/Stage";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

type Call = [operation: string, input?: unknown];
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const createdAt = "2026-01-01T00:00:00Z";
const updatedAt = "2026-01-01T00:00:01Z";

const redactedValue = (
  value: string | Redacted.Redacted<string> | undefined,
) => {
  if (!Redacted.isRedacted(value)) {
    throw new Error("Expected a redacted value");
  }
  return Redacted.value(value);
};

const expectJsonNotToContain = (value: unknown, ...secrets: string[]) => {
  const json = JSON.stringify(value);
  for (const secret of secrets) {
    expect(json).not.toContain(secret);
  }
};

const resourceRef = (kind: string, id: string, name = id) => ({
  id,
  url: `https://api.prisma.test/v1/${kind}/${id}`,
  name,
});

const makeClient = () => {
  const calls: Call[] = [];
  const client = {
    listProjects: () => {
      calls.push(["listProjects"]);
      return Effect.succeed([]);
    },
    createProject: (input: unknown) => {
      calls.push(["createProject", input]);
      return Effect.succeed({
        id: "project-1",
        type: "project",
        url: "https://api.prisma.test/v1/projects/project-1",
        name: "app",
        createdAt,
        defaultRegion: "us-east-1",
        workspace: resourceRef("workspaces", "workspace-1", "team"),
        database: null,
      });
    },
    listProjectDatabases: (projectId: string, query: unknown) => {
      calls.push(["listProjectDatabases", { projectId, query }]);
      return Effect.succeed([]);
    },
    createDatabase: (input: unknown) => {
      calls.push(["createDatabase", input]);
      return Effect.succeed({
        id: "database-1",
        type: "database",
        url: "https://api.prisma.test/v1/databases/database-1",
        name: "main",
        status: "ready",
        createdAt,
        isDefault: false,
        defaultConnectionId: "connection-1",
        connections: [
          {
            id: "connection-1",
            type: "connection",
            url: "https://api.prisma.test/v1/connections/connection-1",
            name: "default",
            createdAt,
            kind: "postgres",
            endpoints: {
              direct: {
                host: "db.prisma.test",
                port: 5432,
                connectionString: "postgres://direct",
              },
              pooled: {
                host: "pool.prisma.test",
                port: 5432,
                connectionString: "postgres://pooled",
              },
            },
            database: resourceRef("databases", "database-1", "main"),
          },
        ],
        project: resourceRef("projects", "project-1", "app"),
        region: { id: "us-east-1", name: "US East" },
        source: { type: "empty" },
        branchId: null,
      });
    },
    listDatabaseConnections: (databaseId: string, query: unknown) => {
      calls.push(["listDatabaseConnections", { databaseId, query }]);
      return Effect.succeed([]);
    },
    createConnection: (input: unknown) => {
      calls.push(["createConnection", input]);
      return Effect.succeed({
        id: "connection-2",
        type: "connection",
        url: "https://api.prisma.test/v1/connections/connection-2",
        name: "api",
        createdAt,
        kind: "postgres",
        endpoints: {
          direct: {
            host: "db.prisma.test",
            port: 5432,
            connectionString: "postgres://api-direct",
          },
        },
        database: resourceRef("databases", "database-1", "main"),
      });
    },
    listBranches: (projectId: string, query: unknown) => {
      calls.push(["listBranches", { projectId, query }]);
      return Effect.succeed([]);
    },
    getBranch: (id: string) => {
      calls.push(["getBranch", id]);
      return Effect.succeed({
        id,
        type: "branch",
        url: `https://api.prisma.test/v1/branches/${id}`,
        gitName: "main",
        isDefault: true,
        createdAt,
        updatedAt,
        project: resourceRef("projects", "project-1", "app"),
      });
    },
    createBranch: (projectId: string, input: unknown) => {
      calls.push(["createBranch", { projectId, input }]);
      return Effect.succeed({
        id: "branch-1",
        type: "branch",
        url: "https://api.prisma.test/v1/branches/branch-1",
        gitName: "main",
        isDefault: true,
        createdAt,
        updatedAt,
        project: resourceRef("projects", "project-1", "app"),
      });
    },
    listProjectComputeServices: (projectId: string, query: unknown) => {
      calls.push(["listProjectComputeServices", { projectId, query }]);
      return Effect.succeed([]);
    },
    createProjectComputeService: (projectId: string, input: unknown) => {
      calls.push(["createProjectComputeService", { projectId, input }]);
      return Effect.succeed({
        id: "service-1",
        type: "compute-service",
        url: "https://api.prisma.test/v1/compute-services/service-1",
        name: "api",
        region: { id: "us-east-1", name: "US East" },
        projectId: "project-1",
        branchId: null,
        latestVersionId: null,
        serviceEndpointDomain: "service-1.prisma.build",
        createdAt,
      });
    },
    getComputeService: (id: string) => {
      calls.push(["getComputeService", id]);
      return Effect.succeed({
        id,
        type: "compute-service",
        url: `https://api.prisma.test/v1/compute-services/${id}`,
        name: "api",
        region: { id: "us-east-1", name: "US East" },
        projectId: "project-1",
        branchId: "branch-1",
        latestVersionId: "version-1",
        serviceEndpointDomain: "service-1.prisma.build",
        createdAt,
      });
    },
    createServiceComputeVersion: (computeServiceId: string, input: unknown) => {
      calls.push(["createServiceComputeVersion", { computeServiceId, input }]);
      return Effect.succeed({
        id: "version-1",
        type: "compute-version",
        url: "https://api.prisma.test/v1/versions/version-1",
        foundryVersionId: "foundry-1",
        uploadUrl: null,
      });
    },
    listComputeServiceDomains: (computeServiceId: string) => {
      calls.push(["listComputeServiceDomains", computeServiceId]);
      return Effect.succeed([]);
    },
    createComputeServiceDomain: (computeServiceId: string, input: unknown) => {
      calls.push(["createComputeServiceDomain", { computeServiceId, input }]);
      return Effect.succeed({
        id: "domain-1",
        type: "custom-domain",
        url: "https://api.prisma.test/v1/domains/domain-1",
        hostname: "api.example.com",
        computeServiceId,
        status: "pending_dns",
        providerStatus: "pending_dns",
        failureReason: null,
        failureCategory: null,
        certExpiresAt: null,
        dnsRecords: [
          {
            type: "CNAME",
            name: "api.example.com",
            value: "service-1.prisma.build",
            ttl: null,
          },
        ],
        createdAt,
        updatedAt,
      });
    },
    getComputeVersion: (id: string) => {
      calls.push(["getComputeVersion", id]);
      return Effect.succeed({
        id,
        type: "compute-version",
        url: `https://api.prisma.test/v1/versions/${id}`,
        foundryVersionId: "foundry-1",
        status: "new",
        previewDomain: null,
        createdAt,
      });
    },
    listEnvironmentVariables: (query: unknown) => {
      calls.push(["listEnvironmentVariables", query]);
      return Effect.succeed([]);
    },
    createEnvironmentVariable: (input: unknown) => {
      calls.push(["createEnvironmentVariable", input]);
      return Effect.succeed({
        id: "env-1",
        type: "environment-variable",
        url: "https://api.prisma.test/v1/environment-variables/env-1",
        projectId: "project-1",
        branchId: null,
        class: "production",
        key: "TOKEN",
        valueKid: "kid-1",
        isManagedBySystem: false,
        createdAt,
        updatedAt,
      });
    },
    listSourceRepositories: (query: unknown) => {
      calls.push(["listSourceRepositories", query]);
      return Effect.succeed([]);
    },
    createSourceRepository: (input: unknown) => {
      calls.push(["createSourceRepository", input]);
      return Effect.succeed({
        id: "repo-1",
        type: "source-repository",
        url: "https://api.prisma.test/v1/source-repositories/repo-1",
        repoId: 123,
        provider: "github",
        repoFullName: "acme/api",
        defaultBranch: "main",
        isPrivate: true,
        status: "active",
        projectId: "project-1",
        installationId: "installation-1",
        createdAt,
        updatedAt,
      });
    },
  } as unknown as PrismaManagementClient;
  return { client, calls };
};

const providerLayer = (client: PrismaManagementClient) =>
  Layer.mergeAll(
    ProjectProvider(),
    DatabaseProvider(),
    ConnectionProvider(),
    BranchProvider(),
    ComputeServiceProvider(),
    ComputeVersionProvider(),
    CustomDomainProvider(),
    EnvironmentVariableProvider(),
    SourceRepositoryProvider(),
  ).pipe(Layer.provide(Layer.succeed(PrismaClient, client)));

const reconcileInput = <Props, Attrs>(
  id: string,
  news: Props,
  output?: Attrs,
  olds?: Props,
) => ({
  id,
  instanceId: "00000000000000000000000000000000",
  news,
  olds,
  output,
  session: undefined as never,
  bindings: [],
});

const deleteInput = (id: string, output: unknown) =>
  ({
    id,
    instanceId: "00000000000000000000000000000000",
    olds: {} as never,
    output,
    session: undefined as never,
    bindings: [],
  }) as never;

const readInput = <Props, Attrs>(id: string, olds: Props, output?: Attrs) =>
  ({
    id,
    instanceId: "00000000000000000000000000000000",
    olds,
    output,
  }) as never;

const diffInput = <Props, Attrs>(olds: Props, news: Props, output?: Attrs) =>
  ({
    id: "Resource",
    instanceId: "00000000000000000000000000000000",
    olds,
    news,
    oldBindings: [],
    newBindings: [],
    output,
  }) as never;

describe("Prisma resource providers", () => {
  it("derives namespaced-safe env keys for connection bindings", () => {
    expect(
      connectionBindingEnvKeys({
        FQN: "Connection",
        LogicalId: "Connection",
      }).directConnectionString,
    ).toBe("PRISMA_CONNECTION_DIRECT_CONNECTION_STRING");
    expect(
      connectionBindingEnvKeys({
        FQN: "Api/Connection",
        LogicalId: "Connection",
      }).directConnectionString,
    ).toBe("PRISMA_API_CONNECTION_DIRECT_CONNECTION_STRING");
  });

  it.effect(
    "builds conventional env vars with Output-safe URL fallbacks",
    () => {
      const connection = {
        Type: "Prisma.Connection",
        LogicalId: "Connection",
        FQN: "Connection",
        connectionId: Output.asOutput("connection-1"),
        databaseId: Output.asOutput("database-1"),
        connectionString: Output.asOutput(Redacted.make("postgres://legacy")),
        directConnectionString: Output.asOutput(undefined),
        pooledConnectionString: Output.asOutput(
          Redacted.make("prisma+postgres://pooled"),
        ),
        accelerateConnectionString: Output.asOutput(undefined),
        host: Output.asOutput(undefined),
        user: Output.asOutput(undefined),
        password: Output.asOutput(undefined),
      } as PrismaConnection;

      return Effect.gen(function* () {
        const url = yield* Output.evaluate(connectionUrl(connection), {});
        const env = connectionEnv(connection);
        const customEnv = connectionEnv(connection, {
          databaseUrl: "APP_DATABASE_URL",
          directUrl: false,
          pooledDatabaseUrl: "POOL_URL",
          connectionId: false,
          databaseId: "DB_ID",
        });
        type DefaultKeys = Expect<
          Equal<
            keyof typeof env,
            | "DATABASE_URL"
            | "DIRECT_URL"
            | "POOLED_DATABASE_URL"
            | "PRISMA_CONNECTION_ID"
            | "PRISMA_DATABASE_ID"
          >
        >;
        type CustomKeys = Expect<
          Equal<
            keyof typeof customEnv,
            "APP_DATABASE_URL" | "POOL_URL" | "DB_ID"
          >
        >;
        const databaseUrl = yield* Output.evaluate(env.DATABASE_URL, {});
        const directUrl = yield* Output.evaluate(env.DIRECT_URL, {});
        const pooledDatabaseUrl = yield* Output.evaluate(
          env.POOLED_DATABASE_URL,
          {},
        );
        const connectionId = yield* Output.evaluate(
          env.PRISMA_CONNECTION_ID,
          {},
        );
        const databaseId = yield* Output.evaluate(env.PRISMA_DATABASE_ID, {});
        const customDatabaseUrl = yield* Output.evaluate(
          customEnv.APP_DATABASE_URL,
          {},
        );
        const customPooledUrl = yield* Output.evaluate(customEnv.POOL_URL, {});
        const customDatabaseId = yield* Output.evaluate(customEnv.DB_ID, {});

        expect(redactedValue(url)).toBe("postgres://legacy");
        expect(redactedValue(databaseUrl)).toBe("postgres://legacy");
        expect(redactedValue(directUrl)).toBe("postgres://legacy");
        expect(redactedValue(pooledDatabaseUrl)).toBe(
          "prisma+postgres://pooled",
        );
        expect(connectionId).toBe("connection-1");
        expect(databaseId).toBe("database-1");
        expect(redactedValue(customDatabaseUrl)).toBe("postgres://legacy");
        expect(redactedValue(customPooledUrl)).toBe("prisma+postgres://pooled");
        expect(customDatabaseId).toBe("database-1");
      });
    },
  );

  it.effect(
    "ConnectionBindingLive resolves bound connection outputs at runtime",
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
      const escapedPooledConnectionString =
        "__ALCHEMY_PRISMA_CONNECTION_VALUE__:prisma://pooled";
      const connection = {
        Type: "Prisma.Connection",
        LogicalId: "Connection",
        FQN: "Api/Connection",
        connectionId: Output.asOutput("connection-1"),
        databaseId: Output.asOutput("database-1"),
        connectionString: Output.asOutput(undefined),
        directConnectionString: Output.asOutput(
          Redacted.make("postgres://direct"),
        ),
        pooledConnectionString: Output.asOutput(
          Redacted.make(escapedPooledConnectionString),
        ),
        accelerateConnectionString: Output.asOutput(undefined),
        host: Output.asOutput("db.example.test"),
        user: Output.asOutput(null),
        password: Output.asOutput(Redacted.make("password")),
      } as PrismaConnection;

      return Effect.gen(function* () {
        const db = yield* ConnectionBinding(connection);
        const keys = connectionBindingEnvKeys(connection);
        const encodedEnv = yield* Output.evaluate(
          capturedBindingEnv ?? {},
          {},
        ) as Effect.Effect<Record<string, unknown>>;

        expect(Object.keys(stored)).toEqual([]);
        expect(encodedEnv[keys.connectionString]).toEqual(expect.any(String));
        expect(encodedEnv[keys.accelerateConnectionString]).toEqual(
          expect.any(String),
        );
        expect(encodedEnv[keys.user]).toEqual(expect.any(String));
        expect(yield* db.connectionId).toBe("connection-1");
        expect(yield* db.databaseUrl).toBe("postgres://direct");
        expect(yield* db.directUrl).toBe("postgres://direct");
        expect(yield* db.connectionString).toBeUndefined();
        expect(yield* db.directConnectionString).toBe("postgres://direct");
        expect(yield* db.pooledDatabaseUrl).toBe(escapedPooledConnectionString);
        expect(yield* db.pooledConnectionString).toBe(
          escapedPooledConnectionString,
        );
        expect(yield* db.accelerateConnectionString).toBeUndefined();
        expect(yield* db.user).toBeNull();
        expect(yield* db.password).toBe("password");
        expect(Object.keys(stored)).toEqual(
          expect.arrayContaining([
            "PRISMA_API_CONNECTION_CONNECTION_ID",
            "PRISMA_API_CONNECTION_CONNECTION_STRING",
            "PRISMA_API_CONNECTION_DIRECT_CONNECTION_STRING",
            "PRISMA_API_CONNECTION_POOLED_CONNECTION_STRING",
            "PRISMA_API_CONNECTION_ACCELERATE_CONNECTION_STRING",
            "PRISMA_API_CONNECTION_USER",
            "PRISMA_API_CONNECTION_PASSWORD",
          ]),
        );
      }).pipe(
        Effect.provide(ConnectionBindingLive),
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
  );

  it.effect(
    "ConnectionBindingLive does not require the deploy-time host at runtime",
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
        connectionString: Output.asOutput(undefined),
        directConnectionString: Output.asOutput(
          Redacted.make("postgres://runtime"),
        ),
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
        const db = yield* ConnectionBinding(connection);

        expect(yield* db.connectionId).toBe("connection-1");
        expect(yield* db.databaseUrl).toBe("postgres://runtime");
      }).pipe(
        Effect.provide(ConnectionBindingLive),
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
        connectionString: Output.asOutput(undefined),
        directConnectionString: Output.asOutput(
          Redacted.make("postgres://api"),
        ),
        pooledConnectionString: Output.asOutput(
          Redacted.make("prisma+postgres://api"),
        ),
        accelerateConnectionString: Output.asOutput(undefined),
        host: Output.asOutput("db.example.test"),
        user: Output.asOutput("api"),
        password: Output.asOutput(Redacted.make("password")),
      } as PrismaConnection;

      return Effect.gen(function* () {
        const app = yield* PrismaCompute(
          "App",
          {
            project: "project-1",
            serviceName: "api",
            main: "app.ts",
          },
          Effect.gen(function* () {
            yield* ConnectionBinding(connection);
          }).pipe(Effect.provide(ConnectionBindingLive)),
        );

        const keys = connectionBindingEnvKeys(connection);
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
        expect(
          redactedValue(env[keys.directConnectionString] ?? undefined),
        ).toBe("postgres://api");
        expect(
          redactedValue(env[keys.pooledConnectionString] ?? undefined),
        ).toBe("prisma+postgres://api");
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
  );

  it.effect("Connection.bind records env for AWS Lambda function hosts", () => {
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
      connectionString: Output.asOutput(undefined),
      directConnectionString: Output.asOutput(Redacted.make("postgres://api")),
      pooledConnectionString: Output.asOutput(undefined),
      accelerateConnectionString: Output.asOutput(undefined),
      host: Output.asOutput("db.example.test"),
      user: Output.asOutput("api"),
      password: Output.asOutput(Redacted.make("password")),
    } as PrismaConnection;

    return Effect.gen(function* () {
      const db = yield* ConnectionBinding(connection);
      const keys = connectionBindingEnvKeys(connection);
      const env = yield* Output.evaluate(
        capturedBindingEnv ?? {},
        {},
      ) as Effect.Effect<Record<string, unknown>>;

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
          env[keys.directConnectionString] as
            | string
            | Redacted.Redacted<string>
            | undefined,
        ),
      ).toBe("postgres://api");
      expect(
        redactedValue(
          env[keys.password] as string | Redacted.Redacted<string> | undefined,
        ),
      ).toBe("password");
      expect(yield* db.databaseUrl).toBe("postgres://api");
    }).pipe(
      Effect.provide(ConnectionBindingLive),
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
  });

  it.effect("Connection.bind records native text bindings for Workers", () => {
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
              bindings?: Output.Output<{
                type: string;
                name: string;
                text: string;
              }>[];
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
      connectionString: Output.asOutput(undefined),
      directConnectionString: Output.asOutput(Redacted.make("postgres://api")),
      pooledConnectionString: Output.asOutput(undefined),
      accelerateConnectionString: Output.asOutput(undefined),
      host: Output.asOutput("db.example.test"),
      user: Output.asOutput("api"),
      password: Output.asOutput(Redacted.make("password")),
    } as PrismaConnection;

    return Effect.gen(function* () {
      const db = yield* ConnectionBinding(connection);
      const keys = connectionBindingEnvKeys(connection);
      const bindings = (yield* Output.evaluate(
        capturedBindings ?? [],
        {},
      )) as Array<{ type: string; name: string; text: string }>;

      for (const binding of bindings) {
        workerEnv[binding.name] = binding.text;
      }

      expect(bindings).toEqual(
        expect.arrayContaining([
          {
            type: "plain_text",
            name: keys.connectionId,
            text: "connection-1",
          },
          {
            type: "plain_text",
            name: keys.databaseId,
            text: "database-1",
          },
          {
            type: "secret_text",
            name: keys.directConnectionString,
            text: "postgres://api",
          },
          {
            type: "secret_text",
            name: keys.password,
            text: "password",
          },
        ]),
      );
      expect(yield* db.connectionString).toBeUndefined();
      expect(yield* db.databaseUrl).toBe("postgres://api");
      expect(yield* db.password).toBe("password");
    }).pipe(
      Effect.provide(ConnectionBindingLive),
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
  });

  it.effect("rejects conflicting ComputeService branch inputs", () => {
    const { client } = makeClient();

    return Effect.gen(function* () {
      const serviceProvider = yield* PrismaComputeService.Provider;
      const error = yield* serviceProvider
        .reconcile(
          reconcileInput("ComputeService", {
            project: "project-1",
            displayName: "api",
            branchId: "branch-1",
            branchGitName: "main",
          }),
        )
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "branchId and branchGitName are mutually exclusive",
      );
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("rejects conflicting Database branch inputs", () => {
    const { client } = makeClient();

    return Effect.gen(function* () {
      const databaseProvider = yield* PrismaDatabase.Provider;
      const error = yield* databaseProvider
        .reconcile(
          reconcileInput("Database", {
            project: "project-1",
            name: "main",
            branchId: "branch-1",
            branchGitName: "main",
          }),
        )
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "branchId and branchGitName are mutually exclusive",
      );
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect(
    "classifies Prisma resource diffs as updates or replacements",
    () => {
      const { client } = makeClient();

      return Effect.gen(function* () {
        const projectProvider = yield* PrismaProject.Provider;
        const databaseProvider = yield* PrismaDatabase.Provider;
        const connectionProvider = yield* PrismaConnection.Provider;
        const branchProvider = yield* PrismaBranch.Provider;
        const serviceProvider = yield* PrismaComputeService.Provider;
        const versionProvider = yield* PrismaComputeVersion.Provider;
        const envProvider = yield* PrismaEnvironmentVariable.Provider;
        const repoProvider = yield* PrismaSourceRepository.Provider;

        expect(
          yield* projectProvider.diff!(
            diffInput(
              { name: "app", region: "us-east-1", createDatabase: false },
              { name: "renamed", region: "us-east-1", createDatabase: false },
            ),
          ),
        ).toEqual({ action: "update" });
        expect(
          yield* projectProvider.diff!(
            diffInput(
              { name: "app", region: "us-east-1", createDatabase: false },
              { name: "app", region: "us-west-2", createDatabase: false },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* projectProvider.diff!(
            diffInput(
              { name: "app", region: "us-east-1", createDatabase: false },
              {
                name: "app",
                region: "us-west-2",
                createDatabase: Output.asOutput(false),
              },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* projectProvider.diff!(
            diffInput(
              { name: "app", region: "us-east-1", createDatabase: false },
              {
                name: "app",
                region: "us-west-2",
                createDatabase: false,
                settings: Output.asOutput({}),
              },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* projectProvider.diff!(
            diffInput(
              {
                name: "app",
                region: "us-east-1",
                createDatabase: false,
                settings: { preview: true, tier: "dev" },
              },
              {
                name: "app",
                region: "us-east-1",
                createDatabase: false,
                settings: { tier: "dev", preview: true },
              },
            ),
          ),
        ).toBeUndefined();

        expect(
          yield* databaseProvider.diff!(
            diffInput(
              { project: "project-1", name: "main", region: "us-east-1" },
              { project: "project-1", name: "primary", region: "us-east-1" },
            ),
          ),
        ).toEqual({ action: "update" });
        expect(
          yield* databaseProvider.diff!(
            diffInput(
              {
                project: "project-1",
                name: "main",
                region: "us-east-1",
                isDefault: false,
              },
              {
                project: "project-1",
                name: "main",
                region: "us-east-1",
                isDefault: true,
              },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* databaseProvider.diff!(
            diffInput(
              {
                project: "project-1",
                name: "main",
                region: "us-east-1",
                source: {
                  type: "backup",
                  databaseId: "database-source",
                  backupId: "backup-1",
                },
              },
              {
                project: "project-1",
                name: "main",
                region: "us-east-1",
                source: {
                  backupId: "backup-1",
                  databaseId: "database-source",
                  type: "backup",
                },
              },
            ),
          ),
        ).toBeUndefined();
        expect(
          yield* databaseProvider.diff!(
            diffInput(
              { project: "project-1", name: "main", region: "us-east-1" },
              {
                project: Output.asOutput("project-1"),
                name: "main",
                region: "us-west-2",
              },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* databaseProvider.diff!(
            diffInput(
              {
                project: "project-1",
                name: "main",
                region: "us-east-1",
                branchId: "branch-1",
              },
              {
                project: "project-1",
                name: "main",
                region: "us-west-2",
                branchId: Output.asOutput("branch-1"),
              },
            ),
          ),
        ).toEqual({ action: "replace" });

        expect(
          yield* connectionProvider.diff!(
            diffInput(
              { database: "database-1", name: "api", rotate: false },
              { database: "database-1", name: "api", rotate: true },
            ),
          ),
        ).toEqual({ action: "update" });
        expect(
          yield* connectionProvider.diff!(
            diffInput(
              { database: "database-1", name: "api" },
              { database: "database-1", name: "worker" },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* connectionProvider.diff!(
            diffInput(
              { database: "database-1", name: "api" },
              { database: Output.asOutput("database-1"), name: "worker" },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* connectionProvider.diff!(
            diffInput(
              { database: "database-1", name: "api", rotate: false },
              {
                database: "database-1",
                name: "worker",
                rotate: Output.asOutput(false),
              },
            ),
          ),
        ).toEqual({ action: "replace" });

        expect(
          yield* branchProvider.diff!(
            diffInput(
              { project: "project-1", gitName: "main", isDefault: false },
              { project: "project-1", gitName: "main", isDefault: true },
            ),
          ),
        ).toEqual({ action: "update" });
        expect(
          yield* branchProvider.diff!(
            diffInput(
              { project: "project-1", gitName: "main" },
              { project: "project-1", gitName: "release" },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* branchProvider.diff!(
            diffInput(
              { project: "project-1", gitName: "main" },
              { project: Output.asOutput("project-1"), gitName: "release" },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* branchProvider.diff!(
            diffInput(
              { project: "project-1", gitName: "main", isDefault: false },
              {
                project: "project-1",
                gitName: "release",
                isDefault: Output.asOutput(false),
              },
            ),
          ),
        ).toEqual({ action: "replace" });

        expect(
          yield* serviceProvider.diff!(
            diffInput(
              {
                project: "project-1",
                displayName: "api",
                regionId: "us-east-1",
              },
              {
                project: "project-1",
                displayName: "web",
                regionId: "us-east-1",
              },
            ),
          ),
        ).toEqual({ action: "update" });
        expect(
          yield* serviceProvider.diff!(
            diffInput(
              {
                project: "project-1",
                displayName: "api",
                regionId: "us-east-1",
              },
              {
                project: "project-1",
                displayName: "api",
                regionId: "us-west-2",
              },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* serviceProvider.diff!(
            diffInput(
              {
                project: "project-1",
                displayName: "api",
                regionId: "us-east-1",
              },
              {
                project: Output.asOutput("project-1"),
                displayName: "api",
                regionId: "us-west-2",
              },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* serviceProvider.diff!(
            diffInput(
              {
                project: "project-1",
                displayName: "api",
                regionId: "us-east-1",
                branchId: "branch-1",
              },
              {
                project: "project-1",
                displayName: "api",
                regionId: "us-west-2",
                branchId: Output.asOutput("branch-1"),
              },
            ),
          ),
        ).toEqual({ action: "replace" });

        expect(
          yield* versionProvider.diff!(
            diffInput(
              { computeService: "service-1", start: false },
              { computeService: "service-1", start: true },
            ),
          ),
        ).toEqual({ action: "update" });
        expect(
          yield* versionProvider.diff!(
            diffInput(
              { computeService: "service-1", portMapping: { http: 3000 } },
              { computeService: "service-1", portMapping: { http: 8080 } },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* versionProvider.diff!(
            diffInput(
              { computeService: "service-1", portMapping: { http: 3000 } },
              {
                computeService: Output.asOutput("service-1"),
                portMapping: { http: 8080 },
              },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* versionProvider.diff!(
            diffInput(
              {
                computeService: "service-1",
                portMapping: { http: 3000 },
                start: false,
              },
              {
                computeService: "service-1",
                portMapping: { http: 8080 },
                start: Output.asOutput(false),
              },
            ),
          ),
        ).toEqual({ action: "replace" });

        expect(
          yield* envProvider.diff!(
            diffInput(
              {
                project: "project-1",
                class: "production" as const,
                key: "TOKEN",
                value: Redacted.make("old"),
              },
              {
                project: "project-1",
                class: "production" as const,
                key: "TOKEN",
                value: Redacted.make("new"),
              },
            ),
          ),
        ).toEqual({ action: "update" });
        expect(
          yield* envProvider.diff!(
            diffInput(
              {
                project: "project-1",
                class: "production" as const,
                key: "TOKEN",
                value: "secret",
              },
              {
                project: "project-1",
                class: "preview" as const,
                key: "TOKEN",
                value: "secret",
              },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* envProvider.diff!(
            diffInput(
              {
                project: "project-1",
                class: "production" as const,
                key: "TOKEN",
                value: "secret",
              },
              {
                project: Output.asOutput("project-1"),
                class: "preview" as const,
                key: "TOKEN",
                value: Output.asOutput("secret"),
              },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* envProvider.diff!(
            diffInput(
              {
                project: "project-1",
                class: "production" as const,
                key: "TOKEN",
                value: "secret",
              },
              {
                project: "project-1",
                class: "preview" as const,
                key: Output.asOutput("TOKEN"),
                value: "secret",
              },
            ),
          ),
        ).toEqual({ action: "replace" });

        expect(
          yield* repoProvider.diff!(
            diffInput(
              { project: "project-1", providerRepositoryId: 123 },
              { project: "project-1", providerRepositoryId: 456 },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* repoProvider.diff!(
            diffInput(
              { project: "project-1", providerRepositoryId: 123 },
              {
                project: Output.asOutput("project-1"),
                providerRepositoryId: 456,
              },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* repoProvider.diff!(
            diffInput(
              {
                project: "project-1",
                providerRepositoryId: 123,
                installationId: "install-1",
              },
              {
                project: "project-1",
                providerRepositoryId: 456,
                installationId: Output.asOutput("install-1"),
              },
            ),
          ),
        ).toEqual({ action: "replace" });
      }).pipe(
        Effect.provide(providerLayer(client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(Stack, {
          name: "prisma-provider-diff-test",
          stage: "test",
          resources: {},
          bindings: {},
          actions: {},
        }),
        Effect.provideService(Stage, "test"),
      );
    },
  );

  it.effect("reads existing Prisma resources for adoption and refresh", () => {
    const calls: Call[] = [];
    const database = {
      id: "database-1",
      type: "database" as const,
      url: "https://api.prisma.test/v1/databases/database-1",
      name: "main",
      status: "ready" as const,
      createdAt,
      isDefault: true,
      defaultConnectionId: "connection-1",
      connections: [],
      project: resourceRef("projects", "project-1", "app"),
      region: { id: "us-east-1", name: "US East" },
      source: { type: "empty" },
      branchId: null,
    };
    const client = {
      listProjects: () =>
        Effect.sync(() => {
          calls.push(["listProjects"]);
          return [
            {
              id: "project-1",
              type: "project" as const,
              url: "https://api.prisma.test/v1/projects/project-1",
              name: "app",
              createdAt,
              defaultRegion: "us-east-1",
              workspace: resourceRef("workspaces", "workspace-1", "team"),
            },
          ];
        }),
      listProjectDatabases: (projectId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listProjectDatabases", { projectId, query }]);
          return [database];
        }),
      listDatabaseConnections: (databaseId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listDatabaseConnections", { databaseId, query }]);
          return [
            {
              id: "connection-1",
              type: "connection" as const,
              url: "https://api.prisma.test/v1/connections/connection-1",
              name: "api",
              createdAt,
              kind: "postgres" as const,
              endpoints: {
                direct: {
                  host: "db.prisma.test",
                  port: 5432,
                },
              },
              database: resourceRef("databases", "database-1", "main"),
            },
          ];
        }),
      listBranches: (projectId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listBranches", { projectId, query }]);
          return [
            {
              id: "branch-1",
              type: "branch" as const,
              url: "https://api.prisma.test/v1/branches/branch-1",
              gitName: "main",
              isDefault: true,
              createdAt,
              updatedAt,
              project: resourceRef("projects", "project-1", "app"),
            },
          ];
        }),
      listProjectComputeServices: (projectId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listProjectComputeServices", { projectId, query }]);
          return [
            {
              id: "service-1",
              type: "compute-service" as const,
              url: "https://api.prisma.test/v1/compute-services/service-1",
              name: "api",
              region: { id: "us-east-1", name: "US East" },
              projectId,
              branchId: "branch-1",
              latestVersionId: "version-1",
              serviceEndpointDomain: "api.prisma.build",
              createdAt,
            },
          ];
        }),
      listServiceComputeVersions: (computeServiceId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push([
            "listServiceComputeVersions",
            { computeServiceId, query },
          ]);
          return [
            {
              id: "version-1",
              type: "compute-version" as const,
              url: "https://api.prisma.test/v1/versions/version-1",
              foundryVersionId: "foundry-1",
              createdAt,
            },
          ];
        }),
      getComputeVersion: (id: string) =>
        Effect.sync(() => {
          calls.push(["getComputeVersion", id]);
          return {
            id,
            type: "compute-version" as const,
            url: `https://api.prisma.test/v1/versions/${id}`,
            foundryVersionId: "foundry-1",
            status: "running",
            previewDomain: "version-1.preview.prisma.build",
            createdAt,
          };
        }),
      listEnvironmentVariables: (query: unknown) =>
        Effect.sync(() => {
          calls.push(["listEnvironmentVariables", query]);
          return [
            {
              id: "env-1",
              type: "environment-variable" as const,
              url: "https://api.prisma.test/v1/environment-variables/env-1",
              projectId: "project-1",
              branchId: null,
              class: "production" as const,
              key: "TOKEN",
              valueKid: "kid-1",
              isManagedBySystem: false,
              createdAt,
              updatedAt,
            },
          ];
        }),
      listSourceRepositories: (query: unknown) =>
        Effect.sync(() => {
          calls.push(["listSourceRepositories", query]);
          return [
            {
              id: "repo-1",
              type: "source-repository" as const,
              url: "https://api.prisma.test/v1/source-repositories/repo-1",
              repoId: 123,
              provider: "github" as const,
              repoFullName: "acme/api",
              defaultBranch: "main",
              isPrivate: true,
              status: "active" as const,
              projectId: "project-1",
              installationId: "installation-1",
              createdAt,
              updatedAt,
            },
          ];
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const projectProvider = yield* PrismaProject.Provider;
      const databaseProvider = yield* PrismaDatabase.Provider;
      const connectionProvider = yield* PrismaConnection.Provider;
      const branchProvider = yield* PrismaBranch.Provider;
      const serviceProvider = yield* PrismaComputeService.Provider;
      const versionProvider = yield* PrismaComputeVersion.Provider;
      const envProvider = yield* PrismaEnvironmentVariable.Provider;
      const repoProvider = yield* PrismaSourceRepository.Provider;

      const project = yield* projectProvider.read!(
        readInput("Project", { name: "app" }),
      );
      const database = yield* databaseProvider.read!(
        readInput("Database", { project: "project-1", name: "main" }),
      );
      const connection = yield* connectionProvider.read!(
        readInput("Connection", { database: "database-1", name: "api" }),
      );
      const branch = yield* branchProvider.read!(
        readInput("Branch", { project: "project-1", gitName: "main" }),
      );
      const service = yield* serviceProvider.read!(
        readInput("ComputeService", {
          project: "project-1",
          displayName: "api",
        }),
      );
      const version = yield* versionProvider.read!(
        readInput(
          "ComputeVersion",
          { computeService: "service-1" },
          {
            computeVersionId: "version-1",
            computeServiceId: "service-1",
            foundryVersionId: "foundry-1",
            status: "new",
            previewDomain: null,
            uploadUrl: null,
            serviceEndpointDomain: undefined,
            createdAt,
          },
        ),
      );
      const env = yield* envProvider.read!(
        readInput("EnvironmentVariable", {
          project: "project-1",
          class: "production" as const,
          key: "TOKEN",
          value: Redacted.make("secret"),
        }),
      );
      const repo = yield* repoProvider.read!(
        readInput("SourceRepository", {
          project: "project-1",
          providerRepositoryId: 123,
        }),
      );

      expect(project?.projectId).toBe("project-1");
      expect(project?.databaseId).toBe("database-1");
      expect(database?.databaseId).toBe("database-1");
      expect(connection?.connectionId).toBe("connection-1");
      expect(branch?.branchId).toBe("branch-1");
      expect(service?.computeServiceId).toBe("service-1");
      expect(version?.computeVersionId).toBe("version-1");
      expect(version?.status).toBe("running");
      expect(env?.environmentVariableId).toBe("env-1");
      expect(env?.valueKid).toBe("kid-1");
      expect(env?.value && Redacted.value(env.value)).toBe("secret");
      expect(repo?.sourceRepositoryId).toBe("repo-1");
      expect(calls.map(([operation]) => operation)).toEqual([
        "listProjects",
        "listProjectDatabases",
        "listProjectDatabases",
        "listDatabaseConnections",
        "listBranches",
        "listProjectComputeServices",
        "getComputeVersion",
        "listEnvironmentVariables",
        "listSourceRepositories",
      ]);
      expect(calls.map(([operation]) => operation)).not.toContain(
        "createProject",
      );
    }).pipe(
      Effect.provide(providerLayer(client)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(Stack, {
        name: "prisma-provider-read-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "test"),
    );
  });

  it.effect("treats Prisma 404 during delete as already gone", () => {
    const calls: Call[] = [];
    const notFound = (method: "GET" | "DELETE", path: string) =>
      new PrismaApiError({
        method,
        path,
        status: 404,
        message: "not found",
      });
    const failNotFound = (
      operation: string,
      id: string,
      method: "GET" | "DELETE",
      path: string,
    ) =>
      Effect.gen(function* () {
        calls.push([operation, id]);
        return yield* Effect.fail(notFound(method, path));
      });

    const client = {
      listProjectComputeServices: (projectId: string) =>
        Effect.sync(() => {
          calls.push(["listProjectComputeServices", projectId]);
          return [];
        }),
      deleteProject: (id: string) =>
        failNotFound("deleteProject", id, "DELETE", `/v1/projects/${id}`),
      getDatabase: (id: string) =>
        failNotFound("getDatabase", id, "GET", `/v1/databases/${id}`),
      deleteDatabase: (id: string) =>
        failNotFound("deleteDatabase", id, "DELETE", `/v1/databases/${id}`),
      deleteConnection: (id: string) =>
        failNotFound("deleteConnection", id, "DELETE", `/v1/connections/${id}`),
      getBranch: (id: string) =>
        failNotFound("getBranch", id, "GET", `/v1/branches/${id}`),
      deleteBranch: (id: string) =>
        failNotFound("deleteBranch", id, "DELETE", `/v1/branches/${id}`),
      getEnvironmentVariable: (id: string) =>
        failNotFound(
          "getEnvironmentVariable",
          id,
          "GET",
          `/v1/environment-variables/${id}`,
        ),
      deleteEnvironmentVariable: (id: string) =>
        failNotFound(
          "deleteEnvironmentVariable",
          id,
          "DELETE",
          `/v1/environment-variables/${id}`,
        ),
      deleteSourceRepository: (id: string) =>
        failNotFound(
          "deleteSourceRepository",
          id,
          "DELETE",
          `/v1/source-repositories/${id}`,
        ),
      listServiceComputeVersions: (computeServiceId: string) =>
        failNotFound(
          "listServiceComputeVersions",
          computeServiceId,
          "GET",
          `/v1/compute-services/${computeServiceId}/versions`,
        ),
      deleteComputeService: (id: string) =>
        failNotFound(
          "deleteComputeService",
          id,
          "DELETE",
          `/v1/compute-services/${id}`,
        ),
      getComputeServiceVersion: (id: string) =>
        failNotFound(
          "getComputeServiceVersion",
          id,
          "GET",
          `/v1/compute-services/versions/${id}`,
        ),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const projectProvider = yield* PrismaProject.Provider;
      const databaseProvider = yield* PrismaDatabase.Provider;
      const connectionProvider = yield* PrismaConnection.Provider;
      const branchProvider = yield* PrismaBranch.Provider;
      const serviceProvider = yield* PrismaComputeService.Provider;
      const versionProvider = yield* PrismaComputeVersion.Provider;
      const envProvider = yield* PrismaEnvironmentVariable.Provider;
      const repoProvider = yield* PrismaSourceRepository.Provider;

      yield* projectProvider.delete!(
        deleteInput("Project", { projectId: "project-1" }),
      );
      yield* databaseProvider.delete!(
        deleteInput("Database", { databaseId: "database-1" }),
      );
      yield* connectionProvider.delete!(
        deleteInput("Connection", { connectionId: "connection-1" }),
      );
      yield* branchProvider.delete!(
        deleteInput("Branch", { branchId: "branch-1" }),
      );
      yield* envProvider.delete!(
        deleteInput("EnvironmentVariable", {
          environmentVariableId: "env-1",
        }),
      );
      yield* repoProvider.delete!(
        deleteInput("SourceRepository", { sourceRepositoryId: "repo-1" }),
      );
      yield* serviceProvider.delete!(
        deleteInput("ComputeService", { computeServiceId: "service-1" }),
      );
      yield* versionProvider.delete!(
        deleteInput("ComputeVersion", { computeVersionId: "version-1" }),
      );

      expect(calls).toEqual([
        ["listProjectComputeServices", "project-1"],
        ["deleteProject", "project-1"],
        ["getDatabase", "database-1"],
        ["deleteConnection", "connection-1"],
        ["getBranch", "branch-1"],
        ["getEnvironmentVariable", "env-1"],
        ["deleteSourceRepository", "repo-1"],
        ["listServiceComputeVersions", "service-1"],
        ["deleteComputeService", "service-1"],
        ["getComputeServiceVersion", "version-1"],
      ]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect(
    "does not delete cloud projects for dev placeholder project IDs",
    () => {
      const calls: Call[] = [];
      const client = {
        listProjects: () =>
          Effect.sync(() => {
            calls.push(["listProjects"]);
            return [
              {
                id: "project-cloud",
                type: "project",
                url: "https://api.prisma.test/v1/projects/project-cloud",
                name: "local-project",
                createdAt,
                defaultRegion: "us-east-1",
                workspace: resourceRef("workspaces", "workspace-1", "team"),
                database: null,
              },
            ];
          }),
        deleteProject: (id: string) =>
          Effect.sync(() => {
            calls.push(["deleteProject", id]);
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const projectProvider = yield* PrismaProject.Provider;

        yield* projectProvider.delete!(
          deleteInput("Project", {
            projectId: "dev:project:Project",
            projectName: "local-project",
          }),
        );

        expect(calls).toEqual([]);
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect(
    "reconciles each greenfield Prisma resource through the client",
    () => {
      const { client, calls } = makeClient();

      return Effect.gen(function* () {
        const projectProvider = yield* PrismaProject.Provider;
        const databaseProvider = yield* PrismaDatabase.Provider;
        const connectionProvider = yield* PrismaConnection.Provider;
        const branchProvider = yield* PrismaBranch.Provider;
        const serviceProvider = yield* PrismaComputeService.Provider;
        const versionProvider = yield* PrismaComputeVersion.Provider;
        const envProvider = yield* PrismaEnvironmentVariable.Provider;
        const repoProvider = yield* PrismaSourceRepository.Provider;

        const project = yield* projectProvider.reconcile(
          reconcileInput("Project", {
            name: "app",
            createDatabase: false,
            region: "us-east-1",
          }),
        );
        const database = yield* databaseProvider.reconcile(
          reconcileInput("Database", {
            project: project.projectId,
            name: "main",
            region: "us-east-1",
          }),
        );
        const connection = yield* connectionProvider.reconcile(
          reconcileInput("Connection", {
            database: database.databaseId,
            name: "api",
          }),
        );
        const branch = yield* branchProvider.reconcile(
          reconcileInput("Branch", {
            project: project.projectId,
            gitName: "main",
            isDefault: true,
          }),
        );
        const service = yield* serviceProvider.reconcile(
          reconcileInput("ComputeService", {
            project: project.projectId,
            displayName: "api",
            regionId: "us-east-1",
          }),
        );
        const version = yield* versionProvider.reconcile(
          reconcileInput("ComputeVersion", {
            computeService: service.computeServiceId,
            portMapping: { http: 3000 },
          }),
        );
        const env = yield* envProvider.reconcile(
          reconcileInput("EnvironmentVariable", {
            project: project.projectId,
            class: "production" as const,
            key: "TOKEN",
            value: Redacted.make("secret"),
          }),
        );
        const repo = yield* repoProvider.reconcile(
          reconcileInput("SourceRepository", {
            project: project.projectId,
            providerRepositoryId: 123,
          }),
        );

        expect(project.projectId).toBe("project-1");
        expect(database.databaseId).toBe("database-1");
        expect(Redacted.value(database.directConnectionString!)).toBe(
          "postgres://direct",
        );
        expect(connection.connectionId).toBe("connection-2");
        expectJsonNotToContain(
          database,
          "postgres://direct",
          "postgres://pooled",
        );
        expectJsonNotToContain(connection, "postgres://api-direct");
        expect(branch.branchId).toBe("branch-1");
        expect(service.computeServiceId).toBe("service-1");
        expect(version.computeVersionId).toBe("version-1");
        expect(env.environmentVariableId).toBe("env-1");
        expect(Redacted.value(env.value)).toBe("secret");
        expectJsonNotToContain(env, "secret");
        expect(repo.sourceRepositoryId).toBe("repo-1");

        expect(calls).toEqual([
          ["listProjects"],
          [
            "createProject",
            { name: "app", createDatabase: false, region: "us-east-1" },
          ],
          [
            "listProjectDatabases",
            { projectId: "project-1", query: { limit: 100 } },
          ],
          [
            "createDatabase",
            {
              projectId: "project-1",
              name: "main",
              region: "us-east-1",
              isDefault: false,
              source: undefined,
              branchId: undefined,
              branchGitName: undefined,
            },
          ],
          [
            "listDatabaseConnections",
            { databaseId: "database-1", query: { limit: 100 } },
          ],
          ["createConnection", { databaseId: "database-1", name: "api" }],
          [
            "listBranches",
            { projectId: "project-1", query: { gitName: "main" } },
          ],
          [
            "createBranch",
            {
              projectId: "project-1",
              input: { gitName: "main", isDefault: true },
            },
          ],
          [
            "listProjectComputeServices",
            { projectId: "project-1", query: { limit: 100 } },
          ],
          [
            "createProjectComputeService",
            {
              projectId: "project-1",
              input: {
                displayName: "api",
                regionId: "us-east-1",
                branchId: undefined,
                branchGitName: undefined,
              },
            },
          ],
          [
            "createServiceComputeVersion",
            {
              computeServiceId: "service-1",
              input: {
                portMapping: { http: 3000 },
                skipCodeUpload: undefined,
              },
            },
          ],
          ["getComputeVersion", "version-1"],
          [
            "listEnvironmentVariables",
            {
              projectId: "project-1",
              class: "production",
              key: "TOKEN",
              limit: 100,
            },
          ],
          [
            "createEnvironmentVariable",
            {
              projectId: "project-1",
              class: "production",
              key: "TOKEN",
              value: "secret",
            },
          ],
          ["listSourceRepositories", { projectId: "project-1", limit: 100 }],
          [
            "createSourceRepository",
            {
              projectId: "project-1",
              provider: "github",
              providerRepositoryId: 123,
            },
          ],
        ]);
      }).pipe(
        Effect.provide(providerLayer(client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(Stack, {
          name: "prisma-provider-test",
          stage: "test",
          resources: {},
          bindings: {},
          actions: {},
        }),
        Effect.provideService(Stage, "test"),
      );
    },
  );

  it.effect("reconciles a Prisma custom domain through the client", () => {
    const { client, calls } = makeClient();

    return Effect.gen(function* () {
      const domainProvider = yield* PrismaCustomDomain.Provider;
      const domain = yield* domainProvider.reconcile(
        reconcileInput("CustomDomain", {
          computeService: "service-1",
          hostname: "api.example.com",
        }),
      );

      expect(domain.customDomainId).toBe("domain-1");
      expect(domain.hostname).toBe("api.example.com");
      expect(domain.computeServiceId).toBe("service-1");
      expect(domain.providerStatus).toBe("pending_dns");
      expect(domain.dnsRecords[0]?.type).toBe("CNAME");
      expect(calls).toEqual([
        ["listComputeServiceDomains", "service-1"],
        ["getComputeService", "service-1"],
        ["getBranch", "branch-1"],
        [
          "createComputeServiceDomain",
          {
            computeServiceId: "service-1",
            input: { hostname: "api.example.com" },
          },
        ],
      ]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("normalizes Prisma custom domain hostnames when matching", () => {
    const { client, calls } = makeClient();
    Object.assign(client, {
      listComputeServiceDomains: (computeServiceId: string) =>
        Effect.sync(() => {
          calls.push(["listComputeServiceDomains", computeServiceId]);
          return [
            {
              id: "domain-1",
              type: "custom-domain" as const,
              url: "https://api.prisma.test/v1/domains/domain-1",
              hostname: "api.example.com",
              computeServiceId,
              status: "pending_dns" as const,
              providerStatus: "pending",
              failureReason: null,
              failureCategory: null,
              certExpiresAt: null,
              dnsRecords: [
                {
                  type: "CNAME" as const,
                  name: "api.example.com",
                  value: "service-1.prisma.build",
                  ttl: null,
                },
              ],
              createdAt,
              updatedAt,
            },
          ];
        }),
    });

    return Effect.gen(function* () {
      const domainProvider = yield* PrismaCustomDomain.Provider;
      const domain = yield* domainProvider.reconcile(
        reconcileInput("CustomDomain", {
          computeService: "service-1",
          hostname: "API.EXAMPLE.COM.",
        }),
      );

      expect(domain.customDomainId).toBe("domain-1");
      expect(domain.hostname).toBe("api.example.com");
      expect(calls).toEqual([["listComputeServiceDomains", "service-1"]]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("rejects Prisma custom domains on non-default branches", () => {
    const { client, calls } = makeClient();
    Object.assign(client, {
      getBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["getBranch", id]);
          return {
            id,
            type: "branch" as const,
            url: `https://api.prisma.test/v1/branches/${id}`,
            gitName: "preview",
            isDefault: false,
            createdAt,
            updatedAt,
            project: resourceRef("projects", "project-1", "app"),
          };
        }),
    });

    return Effect.gen(function* () {
      const domainProvider = yield* PrismaCustomDomain.Provider;
      const error = yield* domainProvider
        .reconcile(
          reconcileInput("CustomDomain", {
            computeService: "service-1",
            hostname: "api.example.com",
          }),
        )
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "custom domains can only be attached to Compute services on the default Branch",
      );
      expect(calls).toEqual([
        ["listComputeServiceDomains", "service-1"],
        ["getComputeService", "service-1"],
        ["getBranch", "branch-1"],
      ]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect(
    "starts a direct compute version only after observing status",
    () => {
      const calls: Call[] = [];
      let status = "new";
      const client = {
        createServiceComputeVersion: (
          computeServiceId: string,
          input: unknown,
        ) =>
          Effect.sync(() => {
            calls.push([
              "createServiceComputeVersion",
              { computeServiceId, input },
            ]);
            return {
              id: "version-1",
              type: "compute-version" as const,
              url: "https://api.prisma.test/v1/versions/version-1",
              foundryVersionId: "foundry-1",
              uploadUrl: null,
            };
          }),
        getComputeVersion: (id: string) =>
          Effect.sync(() => {
            calls.push(["getComputeVersion", id]);
            return {
              id,
              type: "compute-version" as const,
              url: `https://api.prisma.test/v1/versions/${id}`,
              foundryVersionId: "foundry-1",
              status,
              previewDomain: null,
              createdAt,
            };
          }),
        startComputeServiceVersion: (id: string) =>
          Effect.sync(() => {
            calls.push(["startComputeServiceVersion", id]);
            status = "running";
            return { previewDomain: "version-1.preview.prisma.build" };
          }),
        startComputeVersion: (id: string) =>
          Effect.sync(() => {
            calls.push(["startComputeVersion", id]);
            status = "running";
            return { previewDomain: "version-1.preview.prisma.build" };
          }),
        getComputeServiceVersion: (id: string) =>
          Effect.sync(() => {
            calls.push(["getComputeServiceVersion", id]);
            return {
              id,
              type: "compute-version" as const,
              url: `https://api.prisma.test/v1/versions/${id}`,
              foundryVersionId: "foundry-1",
              status,
              previewDomain: "version-1.preview.prisma.build",
              createdAt,
            };
          }),
        getComputeService: (id: string) =>
          Effect.sync(() => {
            calls.push(["getComputeService", id]);
            return {
              id,
              type: "compute-service" as const,
              url: `https://api.prisma.test/v1/compute-services/${id}`,
              name: "api",
              region: { id: "us-east-1", name: "US East" },
              projectId: "project-1",
              branchId: null,
              latestVersionId: null,
              serviceEndpointDomain: "api.prisma.build",
              createdAt,
            };
          }),
        promoteComputeService: (computeServiceId: string, versionId: string) =>
          Effect.sync(() => {
            calls.push([
              "promoteComputeService",
              { computeServiceId, versionId },
            ]);
            return { serviceEndpointDomain: "api.prisma.build" };
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* PrismaComputeVersion.Provider;
        const output = yield* provider.reconcile(
          reconcileInput("ComputeVersion", {
            computeService: "service-1",
            start: true,
            promote: true,
          }),
        );

        expect(output.status).toBe("running");
        expect(output.previewDomain).toBe("version-1.preview.prisma.build");
        expect(output.serviceEndpointDomain).toBe("api.prisma.build");
        expect(calls).toEqual([
          [
            "createServiceComputeVersion",
            {
              computeServiceId: "service-1",
              input: {
                portMapping: undefined,
                skipCodeUpload: undefined,
              },
            },
          ],
          ["getComputeServiceVersion", "version-1"],
          ["startComputeServiceVersion", "version-1"],
          ["getComputeServiceVersion", "version-1"],
          ["getComputeService", "service-1"],
          [
            "promoteComputeService",
            { computeServiceId: "service-1", versionId: "version-1" },
          ],
        ]);
      }).pipe(
        Effect.provide(providerLayer(client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(Stack, {
          name: "prisma-compute-version-test",
          stage: "test",
          resources: {},
          bindings: {},
          actions: {},
        }),
        Effect.provideService(Stage, "test"),
      );
    },
  );

  it.effect(
    "ignores branch env overrides when reconciling project env vars",
    () => {
      const calls: Call[] = [];
      const branchVariable = {
        id: "env-branch",
        type: "environment-variable" as const,
        url: "https://api.prisma.test/v1/environment-variables/env-branch",
        projectId: "project-1",
        branchId: "branch-1",
        class: "production" as const,
        key: "TOKEN",
        valueKid: "kid-branch",
        isManagedBySystem: false,
        createdAt,
        updatedAt,
      };
      const projectVariable = {
        id: "env-project",
        type: "environment-variable" as const,
        url: "https://api.prisma.test/v1/environment-variables/env-project",
        projectId: "project-1",
        branchId: null,
        class: "production" as const,
        key: "TOKEN",
        valueKid: "kid-old",
        isManagedBySystem: false,
        createdAt,
        updatedAt,
      };
      const client = {
        listEnvironmentVariables: (query: unknown) =>
          Effect.sync(() => {
            calls.push(["listEnvironmentVariables", query]);
            return [
              branchVariable,
              { ...branchVariable, id: "env-branch-2", branchId: "branch-2" },
              projectVariable,
            ];
          }),
        updateEnvironmentVariable: (id: string, input: unknown) =>
          Effect.sync(() => {
            calls.push(["updateEnvironmentVariable", { id, input }]);
            return {
              ...projectVariable,
              id,
              valueKid: "kid-new",
              updatedAt: "2026-01-01T00:00:02Z",
            };
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const envProvider = yield* PrismaEnvironmentVariable.Provider;
        const env = yield* envProvider.reconcile(
          reconcileInput("EnvironmentVariable", {
            project: "project-1",
            class: "production" as const,
            key: "TOKEN",
            value: Redacted.make("secret"),
          }),
        );

        expect(env.environmentVariableId).toBe("env-project");
        expect(env.branchId).toBeNull();
        expect(redactedValue(env.value)).toBe("secret");
        expect(calls).toEqual([
          [
            "listEnvironmentVariables",
            {
              projectId: "project-1",
              class: "production",
              key: "TOKEN",
              limit: 100,
            },
          ],
          [
            "updateEnvironmentVariable",
            { id: "env-project", input: { value: "secret" } },
          ],
        ]);
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect("refuses to mutate system-managed environment variables", () => {
    const calls: Call[] = [];
    const systemVariable = {
      id: "env-system",
      type: "environment-variable" as const,
      url: "https://api.prisma.test/v1/environment-variables/env-system",
      projectId: "project-1",
      branchId: null,
      class: "production" as const,
      key: "PRISMA_INTERNAL_URL",
      valueKid: "kid-system",
      isManagedBySystem: true,
      createdAt,
      updatedAt,
    };
    const client = {
      listEnvironmentVariables: (query: unknown) =>
        Effect.sync(() => {
          calls.push(["listEnvironmentVariables", query]);
          return [systemVariable];
        }),
      updateEnvironmentVariable: (id: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["updateEnvironmentVariable", { id, input }]);
          return systemVariable;
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const envProvider = yield* PrismaEnvironmentVariable.Provider;
      const error = yield* envProvider
        .reconcile(
          reconcileInput("EnvironmentVariable", {
            project: "project-1",
            class: "production" as const,
            key: "PRISMA_INTERNAL_URL",
            value: Redacted.make("secret"),
          }),
        )
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "is managed by Prisma and cannot be managed by Alchemy",
      );
      expect(calls).toEqual([
        [
          "listEnvironmentVariables",
          {
            projectId: "project-1",
            class: "production",
            key: "PRISMA_INTERNAL_URL",
            limit: 100,
          },
        ],
      ]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect(
    "skips direct delete for system-managed environment variables",
    () => {
      const calls: Call[] = [];
      const notes: string[] = [];
      const client = {
        getEnvironmentVariable: (id: string) =>
          Effect.sync(() => {
            calls.push(["getEnvironmentVariable", id]);
            return {
              id,
              type: "environment-variable" as const,
              url: `https://api.prisma.test/v1/environment-variables/${id}`,
              projectId: "project-1",
              branchId: null,
              class: "production" as const,
              key: "PRISMA_INTERNAL_URL",
              valueKid: "kid-system",
              isManagedBySystem: true,
              createdAt,
              updatedAt,
            };
          }),
        deleteEnvironmentVariable: (id: string) =>
          Effect.sync(() => {
            calls.push(["deleteEnvironmentVariable", id]);
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const envProvider = yield* PrismaEnvironmentVariable.Provider;
        yield* envProvider.delete!({
          id: "EnvironmentVariable",
          instanceId: "00000000000000000000000000000000",
          olds: {} as never,
          output: {
            environmentVariableId: "env-system",
            projectId: "project-1",
            branchId: null,
            class: "production",
            key: "PRISMA_INTERNAL_URL",
            value: Redacted.make("secret"),
            valueKid: "kid-system",
            isManagedBySystem: true,
            createdAt,
            updatedAt,
          },
          session: {
            note: (message: string) =>
              Effect.sync(() => {
                notes.push(message);
              }),
          } as never,
          bindings: [],
        });

        expect(calls).toEqual([["getEnvironmentVariable", "env-system"]]);
        expect(notes).toEqual([
          "Skipping direct delete for system-managed Prisma environment variable 'PRISMA_INTERNAL_URL'.",
        ]);
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect(
    "checks live environment variable ownership before deleting",
    () => {
      const calls: Call[] = [];
      const client = {
        getEnvironmentVariable: (id: string) =>
          Effect.sync(() => {
            calls.push(["getEnvironmentVariable", id]);
            return {
              id,
              type: "environment-variable" as const,
              url: `https://api.prisma.test/v1/environment-variables/${id}`,
              projectId: "project-1",
              branchId: null,
              class: "production" as const,
              key: "PRISMA_INTERNAL_URL",
              valueKid: "kid-system",
              isManagedBySystem: true,
              createdAt,
              updatedAt,
            };
          }),
        deleteEnvironmentVariable: (id: string) =>
          Effect.sync(() => {
            calls.push(["deleteEnvironmentVariable", id]);
          }),
      } as unknown as PrismaManagementClient;

      const session = {
        note: (message: string) =>
          Effect.sync(() => {
            calls.push(["note", message]);
          }),
      };

      return Effect.gen(function* () {
        const envProvider = yield* PrismaEnvironmentVariable.Provider;
        yield* envProvider.delete!({
          id: "EnvironmentVariable",
          instanceId: "00000000000000000000000000000000",
          olds: {} as never,
          output: {
            environmentVariableId: "env-system",
            projectId: "project-1",
            branchId: null,
            class: "production",
            key: "TOKEN",
            value: Redacted.make("secret"),
            valueKid: "kid-user",
            isManagedBySystem: false,
            createdAt,
            updatedAt,
          },
          session: session as never,
          bindings: [],
        });

        expect(calls).toEqual([
          ["getEnvironmentVariable", "env-system"],
          [
            "note",
            "Skipping direct delete for system-managed Prisma environment variable 'PRISMA_INTERNAL_URL'.",
          ],
        ]);
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect(
    "deletes an environment variable when stale state says system-managed",
    () => {
      const calls: Call[] = [];
      const client = {
        getEnvironmentVariable: (id: string) =>
          Effect.sync(() => {
            calls.push(["getEnvironmentVariable", id]);
            return {
              id,
              type: "environment-variable" as const,
              url: `https://api.prisma.test/v1/environment-variables/${id}`,
              projectId: "project-1",
              branchId: null,
              class: "production" as const,
              key: "TOKEN",
              valueKid: "kid-user",
              isManagedBySystem: false,
              createdAt,
              updatedAt,
            };
          }),
        deleteEnvironmentVariable: (id: string) =>
          Effect.sync(() => {
            calls.push(["deleteEnvironmentVariable", id]);
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const envProvider = yield* PrismaEnvironmentVariable.Provider;
        yield* envProvider.delete!({
          id: "EnvironmentVariable",
          instanceId: "00000000000000000000000000000000",
          olds: {} as never,
          output: {
            environmentVariableId: "env-1",
            projectId: "project-1",
            branchId: null,
            class: "production",
            key: "PRISMA_INTERNAL_URL",
            value: Redacted.make("secret"),
            valueKid: "kid-system",
            isManagedBySystem: true,
            createdAt,
            updatedAt,
          },
          session: undefined as never,
          bindings: [],
        });

        expect(calls).toEqual([
          ["getEnvironmentVariable", "env-1"],
          ["deleteEnvironmentVariable", "env-1"],
        ]);
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect("validates Prisma environment variable writes locally", () => {
    const calls: Call[] = [];
    const client = {
      listEnvironmentVariables: (query: unknown) =>
        Effect.sync(() => {
          calls.push(["listEnvironmentVariables", query]);
          return [];
        }),
      createEnvironmentVariable: (input: unknown) =>
        Effect.sync(() => {
          calls.push(["createEnvironmentVariable", input]);
          return {
            id: "env-1",
            type: "environment-variable" as const,
            url: "https://api.prisma.test/v1/environment-variables/env-1",
            projectId: "project-1",
            branchId: null,
            class: "production" as const,
            key: "TOKEN",
            valueKid: "kid-1",
            isManagedBySystem: false,
            createdAt,
            updatedAt,
          };
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const envProvider = yield* PrismaEnvironmentVariable.Provider;
      const invalidKey = yield* envProvider
        .reconcile(
          reconcileInput("EnvironmentVariable", {
            project: "project-1",
            class: "production" as const,
            key: "bad-key",
            value: Redacted.make("secret"),
          }),
        )
        .pipe(Effect.flip);
      const emptyValue = yield* envProvider
        .reconcile(
          reconcileInput("EnvironmentVariable", {
            project: "project-1",
            class: "production" as const,
            key: "TOKEN",
            value: "",
          }),
        )
        .pipe(Effect.flip);

      expect(invalidKey).toBeInstanceOf(Error);
      expect((invalidKey as Error).message).toContain(
        "must match POSIX env-var key shape",
      );
      expect(emptyValue).toBeInstanceOf(Error);
      expect((emptyValue as Error).message).toContain(
        "value must be non-empty",
      );
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("updates mutable Prisma resources from observed state", () => {
    const calls: Call[] = [];
    const client = {
      getDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["getDatabase", id]);
          return {
            id,
            type: "database" as const,
            url: `https://api.prisma.test/v1/databases/${id}`,
            name: "main",
            status: "ready" as const,
            createdAt,
            isDefault: false,
            defaultConnectionId: "connection-1",
            connections: [],
            project: resourceRef("projects", "project-1", "app"),
            region: { id: "us-east-1", name: "US East" },
            source: { type: "empty" },
            branchId: null,
          };
        }),
      updateDatabase: (id: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["updateDatabase", { id, input }]);
          return {
            id,
            type: "database" as const,
            url: `https://api.prisma.test/v1/databases/${id}`,
            name: "primary",
            status: "ready" as const,
            createdAt,
            isDefault: false,
            defaultConnectionId: "connection-1",
            connections: [],
            project: resourceRef("projects", "project-1", "app"),
            region: { id: "us-east-1", name: "US East" },
            source: { type: "empty" },
            branchId: "branch-1",
          };
        }),
      getConnection: (id: string) =>
        Effect.sync(() => {
          calls.push(["getConnection", id]);
          return {
            id,
            type: "connection" as const,
            url: `https://api.prisma.test/v1/connections/${id}`,
            name: "api",
            createdAt,
            kind: "postgres" as const,
            endpoints: {
              direct: {
                host: "db.prisma.test",
                port: 5432,
                connectionString: "postgres://old-direct",
              },
            },
            database: resourceRef("databases", "database-1", "main"),
          };
        }),
      rotateConnection: (id: string) =>
        Effect.sync(() => {
          calls.push(["rotateConnection", id]);
          return {
            id,
            type: "connection" as const,
            url: `https://api.prisma.test/v1/connections/${id}`,
            name: "api",
            createdAt,
            kind: "postgres" as const,
            endpoints: {
              direct: {
                host: "db.prisma.test",
                port: 5432,
                connectionString: "postgres://new-direct",
              },
            },
            directConnection: {
              host: "db.prisma.test",
              user: "app",
              pass: "new-password",
            },
            database: resourceRef("databases", "database-1", "main"),
          };
        }),
      getBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["getBranch", id]);
          return {
            id,
            type: "branch" as const,
            url: `https://api.prisma.test/v1/branches/${id}`,
            gitName: "main",
            isDefault: false,
            createdAt,
            updatedAt,
            project: resourceRef("projects", "project-1", "app"),
          };
        }),
      updateBranch: (id: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["updateBranch", { id, input }]);
          return {
            id,
            type: "branch" as const,
            url: `https://api.prisma.test/v1/branches/${id}`,
            gitName: "main",
            isDefault: true,
            createdAt,
            updatedAt: "2026-01-01T00:00:02Z",
            project: resourceRef("projects", "project-1", "app"),
          };
        }),
      getComputeService: (id: string) =>
        Effect.sync(() => {
          calls.push(["getComputeService", id]);
          return {
            id,
            type: "compute-service" as const,
            url: `https://api.prisma.test/v1/compute-services/${id}`,
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: null,
            latestVersionId: null,
            serviceEndpointDomain: "service-1.prisma.build",
            createdAt,
          };
        }),
      updateComputeService: (id: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["updateComputeService", { id, input }]);
          return {
            id,
            type: "compute-service" as const,
            url: `https://api.prisma.test/v1/compute-services/${id}`,
            name: "web",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: "branch-1",
            latestVersionId: null,
            serviceEndpointDomain: "service-1.prisma.build",
            createdAt,
          };
        }),
      getEnvironmentVariable: (id: string) =>
        Effect.sync(() => {
          calls.push(["getEnvironmentVariable", id]);
          return {
            id,
            type: "environment-variable" as const,
            url: `https://api.prisma.test/v1/environment-variables/${id}`,
            projectId: "project-1",
            branchId: null,
            class: "production" as const,
            key: "TOKEN",
            valueKid: "kid-old",
            isManagedBySystem: false,
            createdAt,
            updatedAt,
          };
        }),
      updateEnvironmentVariable: (id: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["updateEnvironmentVariable", { id, input }]);
          return {
            id,
            type: "environment-variable" as const,
            url: `https://api.prisma.test/v1/environment-variables/${id}`,
            projectId: "project-1",
            branchId: null,
            class: "production" as const,
            key: "TOKEN",
            valueKid: "kid-new",
            isManagedBySystem: false,
            createdAt,
            updatedAt: "2026-01-01T00:00:02Z",
          };
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const databaseProvider = yield* PrismaDatabase.Provider;
      const connectionProvider = yield* PrismaConnection.Provider;
      const branchProvider = yield* PrismaBranch.Provider;
      const serviceProvider = yield* PrismaComputeService.Provider;
      const envProvider = yield* PrismaEnvironmentVariable.Provider;

      const database = yield* databaseProvider.reconcile(
        reconcileInput(
          "Database",
          {
            project: "project-1",
            name: "primary",
            region: "us-east-1",
            branchId: "branch-1",
          },
          {
            databaseId: "database-1",
            databaseName: "main",
            projectId: "project-1",
            status: "ready",
            region: "us-east-1",
            isDefault: false,
            branchId: null,
            defaultConnectionId: "connection-1",
            createdAt,
            connectionString: undefined,
            directConnectionString: undefined,
            pooledConnectionString: undefined,
            accelerateConnectionString: undefined,
            host: undefined,
            user: undefined,
            password: undefined,
          },
        ),
      );
      const connection = yield* connectionProvider.reconcile(
        reconcileInput(
          "Connection",
          {
            database: "database-1",
            name: "api",
            rotate: true,
          },
          {
            connectionId: "connection-1",
            connectionName: "api",
            databaseId: "database-1",
            kind: "postgres" as const,
            createdAt,
            connectionString: undefined,
            directConnectionString: Redacted.make("postgres://old-direct"),
            pooledConnectionString: undefined,
            accelerateConnectionString: undefined,
            host: "db.prisma.test",
            user: undefined,
            password: undefined,
          },
          {
            database: "database-1",
            name: "api",
            rotate: false,
          },
        ),
      );
      const branch = yield* branchProvider.reconcile(
        reconcileInput(
          "Branch",
          {
            project: "project-1",
            gitName: "main",
            isDefault: true,
          },
          {
            branchId: "branch-1",
            gitName: "main",
            projectId: "project-1",
            isDefault: false,
            role: "production",
            createdAt,
            updatedAt,
          },
        ),
      );
      const service = yield* serviceProvider.reconcile(
        reconcileInput(
          "ComputeService",
          {
            project: "project-1",
            displayName: "web",
            regionId: "us-east-1",
            branchId: "branch-1",
          },
          {
            computeServiceId: "service-1",
            name: "api",
            projectId: "project-1",
            regionId: "us-east-1",
            branchId: null,
            latestVersionId: null,
            serviceEndpointDomain: "service-1.prisma.build",
            createdAt,
          },
        ),
      );
      const env = yield* envProvider.reconcile(
        reconcileInput(
          "EnvironmentVariable",
          {
            project: "project-1",
            class: "production" as const,
            key: "TOKEN",
            value: Redacted.make("new-secret"),
          },
          {
            environmentVariableId: "env-1",
            projectId: "project-1",
            branchId: null,
            class: "production" as const,
            key: "TOKEN",
            value: Redacted.make("old-secret"),
            valueKid: "kid-old",
            isManagedBySystem: false,
            createdAt,
            updatedAt,
          },
        ),
      );

      expect(database.databaseName).toBe("primary");
      expect(database.branchId).toBe("branch-1");
      expect(Redacted.value(connection.directConnectionString!)).toBe(
        "postgres://new-direct",
      );
      expect(connection.user).toBe("app");
      expect(Redacted.value(connection.password!)).toBe("new-password");
      expectJsonNotToContain(
        connection,
        "postgres://new-direct",
        "new-password",
      );
      expect(branch.isDefault).toBe(true);
      expect(service.name).toBe("web");
      expect(service.branchId).toBe("branch-1");
      expect(env.valueKid).toBe("kid-new");
      expect(Redacted.value(env.value)).toBe("new-secret");
      expectJsonNotToContain(env, "new-secret");
      expect(calls).toEqual([
        ["getDatabase", "database-1"],
        [
          "updateDatabase",
          {
            id: "database-1",
            input: {
              name: "primary",
              branchId: "branch-1",
              branchGitName: undefined,
            },
          },
        ],
        ["getConnection", "connection-1"],
        ["rotateConnection", "connection-1"],
        ["getBranch", "branch-1"],
        ["updateBranch", { id: "branch-1", input: { isDefault: true } }],
        ["getComputeService", "service-1"],
        [
          "updateComputeService",
          {
            id: "service-1",
            input: {
              displayName: "web",
              branchId: "branch-1",
              branchGitName: undefined,
            },
          },
        ],
        ["getEnvironmentVariable", "env-1"],
        [
          "updateEnvironmentVariable",
          { id: "env-1", input: { value: "new-secret" } },
        ],
      ]);
    }).pipe(
      Effect.provide(providerLayer(client)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(Stack, {
        name: "prisma-provider-update-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "test"),
    );
  });

  it.effect(
    "skips branchGitName updates when observed branch ids already match",
    () => {
      const calls: Call[] = [];
      const branch = {
        id: "branch-main",
        type: "branch" as const,
        url: "https://api.prisma.test/v1/branches/branch-main",
        gitName: "main",
        isDefault: true,
        createdAt,
        updatedAt,
        project: resourceRef("projects", "project-1", "app"),
      };
      const client = {
        getDatabase: (id: string) =>
          Effect.sync(() => {
            calls.push(["getDatabase", id]);
            return {
              id,
              type: "database" as const,
              url: `https://api.prisma.test/v1/databases/${id}`,
              name: "main",
              status: "ready" as const,
              createdAt,
              isDefault: false,
              defaultConnectionId: "connection-1",
              connections: [],
              project: resourceRef("projects", "project-1", "app"),
              region: { id: "us-east-1", name: "US East" },
              source: { type: "empty" },
              branchId: "branch-main",
            };
          }),
        getComputeService: (id: string) =>
          Effect.sync(() => {
            calls.push(["getComputeService", id]);
            return {
              id,
              type: "compute-service" as const,
              url: `https://api.prisma.test/v1/compute-services/${id}`,
              name: "api",
              region: { id: "us-east-1", name: "US East" },
              projectId: "project-1",
              branchId: "branch-main",
              latestVersionId: null,
              serviceEndpointDomain: "service-1.prisma.build",
              createdAt,
            };
          }),
        listBranches: (projectId: string, query: unknown) =>
          Effect.sync(() => {
            calls.push(["listBranches", { projectId, query }]);
            return [branch];
          }),
        updateDatabase: (id: string, input: unknown) =>
          Effect.sync(() => {
            calls.push(["updateDatabase", { id, input }]);
            throw new Error("updateDatabase should not be called");
          }),
        updateComputeService: (id: string, input: unknown) =>
          Effect.sync(() => {
            calls.push(["updateComputeService", { id, input }]);
            throw new Error("updateComputeService should not be called");
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const databaseProvider = yield* PrismaDatabase.Provider;
        const serviceProvider = yield* PrismaComputeService.Provider;

        const database = yield* databaseProvider.reconcile(
          reconcileInput(
            "Database",
            {
              project: "project-1",
              name: "main",
              region: "us-east-1",
              branchGitName: "main",
            },
            {
              databaseId: "database-1",
              databaseName: "main",
              projectId: "project-1",
              status: "ready",
              region: "us-east-1",
              isDefault: false,
              branchId: "branch-main",
              defaultConnectionId: "connection-1",
              createdAt,
              connectionString: undefined,
              directConnectionString: undefined,
              pooledConnectionString: undefined,
              accelerateConnectionString: undefined,
              host: undefined,
              user: undefined,
              password: undefined,
            },
          ),
        );
        const service = yield* serviceProvider.reconcile(
          reconcileInput(
            "ComputeService",
            {
              project: "project-1",
              displayName: "api",
              regionId: "us-east-1",
              branchGitName: "main",
            },
            {
              computeServiceId: "service-1",
              name: "api",
              projectId: "project-1",
              regionId: "us-east-1",
              branchId: "branch-main",
              latestVersionId: null,
              serviceEndpointDomain: "service-1.prisma.build",
              createdAt,
            },
          ),
        );

        expect(database.branchId).toBe("branch-main");
        expect(service.branchId).toBe("branch-main");
        expect(calls).toEqual([
          ["getDatabase", "database-1"],
          [
            "listBranches",
            { projectId: "project-1", query: { gitName: "main", limit: 1 } },
          ],
          ["getComputeService", "service-1"],
          [
            "listBranches",
            { projectId: "project-1", query: { gitName: "main", limit: 1 } },
          ],
        ]);
      }).pipe(
        Effect.provide(providerLayer(client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(Stack, {
          name: "prisma-branch-noop-test",
          stage: "test",
          resources: {},
          bindings: {},
          actions: {},
        }),
        Effect.provideService(Stage, "test"),
      );
    },
  );

  it.effect(
    "syncs branchGitName after creating a database when Prisma omits branchId",
    () => {
      const calls: Call[] = [];
      const database = {
        id: "database-1",
        type: "database" as const,
        url: "https://api.prisma.test/v1/databases/database-1",
        name: "main",
        status: "ready" as const,
        createdAt,
        isDefault: false,
        defaultConnectionId: "connection-1",
        connections: [],
        project: resourceRef("projects", "project-1", "app"),
        region: { id: "us-east-1", name: "US East" },
        source: { type: "empty" },
        branchId: null,
      };
      const client = {
        listProjectDatabases: (projectId: string, query: unknown) =>
          Effect.sync(() => {
            calls.push(["listProjectDatabases", { projectId, query }]);
            return [];
          }),
        createDatabase: (input: unknown) =>
          Effect.sync(() => {
            calls.push(["createDatabase", input]);
            return database;
          }),
        updateDatabase: (id: string, input: unknown) =>
          Effect.sync(() => {
            calls.push(["updateDatabase", { id, input }]);
            return {
              ...database,
              branchId: "branch-main",
            };
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* PrismaDatabase.Provider;
        const output = yield* provider.reconcile(
          reconcileInput("Database", {
            project: "project-1",
            name: "main",
            region: "us-east-1",
            branchGitName: "main",
          }),
        );

        expect(output.branchId).toBe("branch-main");
        expect(calls).toEqual([
          [
            "listProjectDatabases",
            { projectId: "project-1", query: { limit: 100 } },
          ],
          [
            "createDatabase",
            {
              projectId: "project-1",
              name: "main",
              region: "us-east-1",
              isDefault: false,
              source: undefined,
              branchId: undefined,
              branchGitName: "main",
            },
          ],
          [
            "updateDatabase",
            {
              id: "database-1",
              input: {
                name: "main",
                branchId: undefined,
                branchGitName: "main",
              },
            },
          ],
        ]);
      }).pipe(
        Effect.provide(providerLayer(client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(Stack, {
          name: "prisma-database-created-branch-sync-test",
          stage: "test",
          resources: {},
          bindings: {},
          actions: {},
        }),
        Effect.provideService(Stage, "test"),
      );
    },
  );

  it.effect("ensures a default database on an existing Prisma project", () => {
    const calls: Call[] = [];
    const client = {
      listProjects: () =>
        Effect.sync(() => {
          calls.push(["listProjects"]);
          return [
            {
              id: "project-1",
              type: "project" as const,
              url: "https://api.prisma.test/v1/projects/project-1",
              name: "app",
              createdAt,
              defaultRegion: "us-east-1",
              workspace: resourceRef("workspaces", "workspace-1", "team"),
            },
          ];
        }),
      listProjectDatabases: (projectId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listProjectDatabases", { projectId, query }]);
          return [
            {
              id: "database-reporting",
              type: "database" as const,
              url: "https://api.prisma.test/v1/databases/database-reporting",
              name: "reporting",
              status: "ready" as const,
              createdAt,
              isDefault: false,
              defaultConnectionId: null,
              connections: [],
              project: resourceRef("projects", "project-1", "app"),
              region: { id: "us-east-1", name: "US East" },
              source: { type: "empty" },
              branchId: null,
            },
          ];
        }),
      createProjectDatabase: (projectId: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["createProjectDatabase", { projectId, input }]);
          return {
            id: "database-1",
            type: "database" as const,
            url: "https://api.prisma.test/v1/databases/database-1",
            name: "main",
            status: "ready" as const,
            createdAt,
            isDefault: true,
            defaultConnectionId: "connection-1",
            connections: [
              {
                id: "connection-1",
                type: "connection" as const,
                url: "https://api.prisma.test/v1/connections/connection-1",
                name: "default",
                createdAt,
                kind: "postgres" as const,
                endpoints: {
                  direct: {
                    host: "db.prisma.test",
                    port: 5432,
                    connectionString: "postgres://direct",
                  },
                },
                database: resourceRef("databases", "database-1", "main"),
              },
            ],
            project: resourceRef("projects", "project-1", "app"),
            region: { id: "us-east-1", name: "US East" },
            source: { type: "empty" },
            branchId: null,
          };
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const projectProvider = yield* PrismaProject.Provider;
      const project = yield* projectProvider.reconcile(
        reconcileInput("Project", { name: "app", region: "us-east-1" }),
      );

      expect(project.projectId).toBe("project-1");
      expect(project.databaseId).toBe("database-1");
      expect(Redacted.value(project.directConnectionString!)).toBe(
        "postgres://direct",
      );
      expectJsonNotToContain(project, "postgres://direct");
      expect(calls).toEqual([
        ["listProjects"],
        [
          "listProjectDatabases",
          { projectId: "project-1", query: { limit: 100 } },
        ],
        [
          "createProjectDatabase",
          {
            projectId: "project-1",
            input: { region: "us-east-1", isDefault: true },
          },
        ],
      ]);
    }).pipe(
      Effect.provide(
        ProjectProvider().pipe(
          Layer.provide(Layer.succeed(PrismaClient, client)),
        ),
      ),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(Stack, {
        name: "prisma-project-ensure-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "test"),
    );
  });

  it.effect("clears previously managed project settings", () => {
    const calls: Call[] = [];
    const client = {
      getProject: (id: string) =>
        Effect.sync(() => {
          calls.push(["getProject", id]);
          return {
            id,
            type: "project" as const,
            url: `https://api.prisma.test/v1/projects/${id}`,
            name: "app",
            createdAt,
            defaultRegion: "us-east-1",
            workspace: resourceRef("workspaces", "workspace-1", "team"),
          };
        }),
      updateProject: (id: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["updateProject", { id, input }]);
          return {
            id,
            type: "project" as const,
            url: `https://api.prisma.test/v1/projects/${id}`,
            name: "app",
            createdAt,
            defaultRegion: "us-east-1",
            workspace: resourceRef("workspaces", "workspace-1", "team"),
          };
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const projectProvider = yield* PrismaProject.Provider;
      const project = yield* projectProvider.reconcile(
        reconcileInput(
          "Project",
          { name: "app", createDatabase: false },
          {
            projectId: "project-1",
            projectName: "app",
            workspaceId: "workspace-1",
            createdAt,
            defaultRegion: "us-east-1",
            databaseId: undefined,
            defaultConnectionId: undefined,
            connectionString: undefined,
            directConnectionString: undefined,
            pooledConnectionString: undefined,
            accelerateConnectionString: undefined,
            host: undefined,
            user: undefined,
            password: undefined,
          },
          {
            name: "app",
            createDatabase: false,
            settings: { preview: true },
          },
        ),
      );

      expect(project.projectId).toBe("project-1");
      expect(calls).toEqual([
        ["getProject", "project-1"],
        [
          "updateProject",
          {
            id: "project-1",
            input: { name: "app", settings: {} },
          },
        ],
      ]);
    }).pipe(
      Effect.provide(
        ProjectProvider().pipe(
          Layer.provide(Layer.succeed(PrismaClient, client)),
        ),
      ),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(Stack, {
        name: "prisma-project-settings-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "test"),
    );
  });

  it.effect("renames a project without clearing unmanaged settings", () => {
    const calls: Call[] = [];
    const client = {
      getProject: (id: string) =>
        Effect.sync(() => {
          calls.push(["getProject", id]);
          return {
            id,
            type: "project" as const,
            url: `https://api.prisma.test/v1/projects/${id}`,
            name: "app",
            createdAt,
            defaultRegion: "us-east-1",
            workspace: resourceRef("workspaces", "workspace-1", "team"),
          };
        }),
      updateProject: (id: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["updateProject", { id, input }]);
          return {
            id,
            type: "project" as const,
            url: `https://api.prisma.test/v1/projects/${id}`,
            name: "renamed",
            createdAt,
            defaultRegion: "us-east-1",
            workspace: resourceRef("workspaces", "workspace-1", "team"),
          };
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const projectProvider = yield* PrismaProject.Provider;
      yield* projectProvider.reconcile(
        reconcileInput(
          "Project",
          { name: "renamed", createDatabase: false },
          {
            projectId: "project-1",
            projectName: "app",
            workspaceId: "workspace-1",
            createdAt,
            defaultRegion: "us-east-1",
            databaseId: undefined,
            defaultConnectionId: undefined,
            connectionString: undefined,
            directConnectionString: undefined,
            pooledConnectionString: undefined,
            accelerateConnectionString: undefined,
            host: undefined,
            user: undefined,
            password: undefined,
          },
          { name: "app", createDatabase: false },
        ),
      );

      expect(calls).toEqual([
        ["getProject", "project-1"],
        [
          "updateProject",
          {
            id: "project-1",
            input: { name: "renamed" },
          },
        ],
      ]);
    }).pipe(
      Effect.provide(
        ProjectProvider().pipe(
          Layer.provide(Layer.succeed(PrismaClient, client)),
        ),
      ),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(Stack, {
        name: "prisma-project-rename-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "test"),
    );
  });

  it.effect("finds the default database when its name is omitted", () => {
    const calls: Call[] = [];
    const client = {
      listProjectDatabases: (projectId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listProjectDatabases", { projectId, query }]);
          return [
            {
              id: "database-reporting",
              type: "database" as const,
              url: "https://api.prisma.test/v1/databases/database-reporting",
              name: "reporting",
              status: "ready" as const,
              createdAt,
              isDefault: false,
              defaultConnectionId: null,
              connections: [],
              project: resourceRef("projects", "project-1", "app"),
              region: { id: "us-east-1", name: "US East" },
              source: { type: "empty" },
              branchId: null,
            },
            {
              id: "database-default",
              type: "database" as const,
              url: "https://api.prisma.test/v1/databases/database-default",
              name: "main",
              status: "ready" as const,
              createdAt,
              isDefault: true,
              defaultConnectionId: "connection-1",
              connections: [],
              project: resourceRef("projects", "project-1", "app"),
              region: { id: "us-east-1", name: "US East" },
              source: { type: "empty" },
              branchId: null,
            },
          ];
        }),
      createDatabase: () => Effect.die("default database should be found"),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const databaseProvider = yield* PrismaDatabase.Provider;
      const database = yield* databaseProvider.reconcile(
        reconcileInput("Database", {
          project: "project-1",
          isDefault: true,
        }),
      );

      expect(database.databaseId).toBe("database-default");
      expect(database.databaseName).toBe("main");
      expect(database.isDefault).toBe(true);
      expect(calls).toEqual([
        [
          "listProjectDatabases",
          { projectId: "project-1", query: { limit: 100 } },
        ],
      ]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("deletes Prisma resources through their management APIs", () => {
    const calls: Call[] = [];
    const status = new Map([["version-1", "running"]]);
    const client = {
      deleteProject: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteProject", id]);
        }),
      deleteDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteDatabase", id]);
        }),
      getDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["getDatabase", id]);
          return { id, isDefault: false };
        }),
      deleteConnection: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteConnection", id]);
        }),
      deleteBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteBranch", id]);
        }),
      getBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["getBranch", id]);
          return { id, isDefault: false };
        }),
      listProjectComputeServices: (projectId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listProjectComputeServices", { projectId, query }]);
          return [];
        }),
      listServiceComputeVersions: (computeServiceId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push([
            "listServiceComputeVersions",
            { computeServiceId, query },
          ]);
          return [
            {
              id: "version-1",
              type: "compute-version" as const,
              url: "https://api.prisma.test/v1/versions/version-1",
              foundryVersionId: "foundry-1",
              createdAt,
            },
          ];
        }),
      getComputeServiceVersion: (id: string) =>
        Effect.sync(() => {
          calls.push(["getComputeServiceVersion", id]);
          return {
            id,
            type: "compute-version" as const,
            url: `https://api.prisma.test/v1/versions/${id}`,
            foundryVersionId: "foundry-1",
            status: status.get(id) ?? "stopped",
            previewDomain: null,
            createdAt,
          };
        }),
      stopComputeServiceVersion: (id: string) =>
        Effect.sync(() => {
          calls.push(["stopComputeServiceVersion", id]);
          status.set(id, "stopped");
        }),
      deleteComputeServiceVersion: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteComputeServiceVersion", id]);
        }),
      deleteComputeService: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteComputeService", id]);
        }),
      deleteCustomDomain: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteCustomDomain", id]);
        }),
      getEnvironmentVariable: (id: string) =>
        Effect.sync(() => {
          calls.push(["getEnvironmentVariable", id]);
          return {
            id,
            type: "environment-variable" as const,
            url: `https://api.prisma.test/v1/environment-variables/${id}`,
            projectId: "project-1",
            branchId: null,
            class: "production" as const,
            key: "TOKEN",
            valueKid: "kid-1",
            isManagedBySystem: false,
            createdAt,
            updatedAt,
          };
        }),
      deleteEnvironmentVariable: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteEnvironmentVariable", id]);
        }),
      deleteSourceRepository: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteSourceRepository", id]);
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const projectProvider = yield* PrismaProject.Provider;
      const databaseProvider = yield* PrismaDatabase.Provider;
      const connectionProvider = yield* PrismaConnection.Provider;
      const branchProvider = yield* PrismaBranch.Provider;
      const serviceProvider = yield* PrismaComputeService.Provider;
      const versionProvider = yield* PrismaComputeVersion.Provider;
      const domainProvider = yield* PrismaCustomDomain.Provider;
      const envProvider = yield* PrismaEnvironmentVariable.Provider;
      const repoProvider = yield* PrismaSourceRepository.Provider;

      yield* versionProvider.delete(
        deleteInput("ComputeVersion", { computeVersionId: "version-1" }),
      );
      yield* serviceProvider.delete(
        deleteInput("ComputeService", { computeServiceId: "service-1" }),
      );
      yield* repoProvider.delete(
        deleteInput("SourceRepository", { sourceRepositoryId: "repo-1" }),
      );
      yield* domainProvider.delete(
        deleteInput("CustomDomain", { customDomainId: "domain-1" }),
      );
      yield* envProvider.delete(
        deleteInput("EnvironmentVariable", { environmentVariableId: "env-1" }),
      );
      yield* branchProvider.delete(
        deleteInput("Branch", { branchId: "branch-1" }),
      );
      yield* connectionProvider.delete(
        deleteInput("Connection", { connectionId: "connection-1" }),
      );
      yield* databaseProvider.delete(
        deleteInput("Database", { databaseId: "database-1" }),
      );
      yield* projectProvider.delete(
        deleteInput("Project", { projectId: "project-1" }),
      );

      expect(calls).toEqual([
        ["getComputeServiceVersion", "version-1"],
        ["stopComputeServiceVersion", "version-1"],
        ["getComputeServiceVersion", "version-1"],
        ["deleteComputeServiceVersion", "version-1"],
        [
          "listServiceComputeVersions",
          { computeServiceId: "service-1", query: { limit: 100 } },
        ],
        ["getComputeServiceVersion", "version-1"],
        ["deleteComputeServiceVersion", "version-1"],
        ["deleteComputeService", "service-1"],
        ["deleteSourceRepository", "repo-1"],
        ["deleteCustomDomain", "domain-1"],
        ["getEnvironmentVariable", "env-1"],
        ["deleteEnvironmentVariable", "env-1"],
        ["getBranch", "branch-1"],
        ["deleteBranch", "branch-1"],
        ["deleteConnection", "connection-1"],
        ["getDatabase", "database-1"],
        ["deleteDatabase", "database-1"],
        [
          "listProjectComputeServices",
          { projectId: "project-1", query: { limit: 100 } },
        ],
        ["deleteProject", "project-1"],
      ]);
    }).pipe(
      Effect.provide(providerLayer(client)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(Stack, {
        name: "prisma-provider-delete-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "test"),
    );
  });

  it.effect("skips direct delete for a default Prisma database", () => {
    const calls: Call[] = [];
    const client = {
      getDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["getDatabase", id]);
          return { id, isDefault: true };
        }),
      deleteDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteDatabase", id]);
        }),
    } as unknown as PrismaManagementClient;

    const session = {
      note: (message: string) =>
        Effect.sync(() => {
          calls.push(["note", message]);
        }),
    };

    return Effect.gen(function* () {
      const databaseProvider = yield* PrismaDatabase.Provider;
      yield* databaseProvider.delete({
        id: "Postgres",
        instanceId: "00000000000000000000000000000000",
        olds: {} as never,
        output: {
          databaseId: "database-1",
          projectId: "project-1",
          isDefault: true,
        },
        session,
        bindings: [],
      } as never);

      expect(calls).toEqual([
        ["getDatabase", "database-1"],
        [
          "note",
          "Skipping direct delete for default Prisma database; Prisma removes it when the owning project is deleted.",
        ],
      ]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("checks live database default state before deleting", () => {
    const calls: Call[] = [];
    const client = {
      getDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["getDatabase", id]);
          return { id, isDefault: true };
        }),
      deleteDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteDatabase", id]);
        }),
    } as unknown as PrismaManagementClient;

    const session = {
      note: (message: string) =>
        Effect.sync(() => {
          calls.push(["note", message]);
        }),
    };

    return Effect.gen(function* () {
      const databaseProvider = yield* PrismaDatabase.Provider;
      yield* databaseProvider.delete({
        id: "Postgres",
        instanceId: "00000000000000000000000000000000",
        olds: {} as never,
        output: {
          databaseId: "database-1",
          projectId: "project-1",
          isDefault: false,
        },
        session,
        bindings: [],
      } as never);

      expect(calls).toEqual([
        ["getDatabase", "database-1"],
        [
          "note",
          "Skipping direct delete for default Prisma database; Prisma removes it when the owning project is deleted.",
        ],
      ]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("skips default Prisma database delete without a session", () => {
    const calls: Call[] = [];
    const client = {
      getDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["getDatabase", id]);
          return { id, isDefault: true };
        }),
      deleteDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteDatabase", id]);
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const databaseProvider = yield* PrismaDatabase.Provider;
      yield* databaseProvider.delete({
        id: "Postgres",
        instanceId: "00000000000000000000000000000000",
        olds: {} as never,
        output: {
          databaseId: "database-1",
          projectId: "project-1",
          isDefault: true,
        },
        session: undefined,
        bindings: [],
      } as never);

      expect(calls).toEqual([["getDatabase", "database-1"]]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("deletes a database when stale state says it is default", () => {
    const calls: Call[] = [];
    const client = {
      getDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["getDatabase", id]);
          return { id, isDefault: false };
        }),
      deleteDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteDatabase", id]);
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const databaseProvider = yield* PrismaDatabase.Provider;
      yield* databaseProvider.delete({
        id: "Postgres",
        instanceId: "00000000000000000000000000000000",
        olds: {} as never,
        output: {
          databaseId: "database-1",
          projectId: "project-1",
          isDefault: true,
        },
        session: undefined,
        bindings: [],
      } as never);

      expect(calls).toEqual([
        ["getDatabase", "database-1"],
        ["deleteDatabase", "database-1"],
      ]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("skips direct delete for a default Prisma branch", () => {
    const calls: Call[] = [];
    const client = {
      getBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["getBranch", id]);
          return { id, isDefault: true };
        }),
      deleteBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteBranch", id]);
        }),
    } as unknown as PrismaManagementClient;

    const session = {
      note: (message: string) =>
        Effect.sync(() => {
          calls.push(["note", message]);
        }),
    };

    return Effect.gen(function* () {
      const branchProvider = yield* PrismaBranch.Provider;
      yield* branchProvider.delete({
        id: "MainBranch",
        instanceId: "00000000000000000000000000000000",
        olds: {} as never,
        output: {
          branchId: "branch-1",
          projectId: "project-1",
          isDefault: true,
        },
        session,
        bindings: [],
      } as never);

      expect(calls).toEqual([
        ["getBranch", "branch-1"],
        [
          "note",
          "Skipping direct delete for default Prisma branch; Prisma removes it when the owning project is deleted.",
        ],
      ]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("checks live branch default state before deleting", () => {
    const calls: Call[] = [];
    const client = {
      getBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["getBranch", id]);
          return { id, isDefault: true };
        }),
      deleteBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteBranch", id]);
        }),
    } as unknown as PrismaManagementClient;

    const session = {
      note: (message: string) =>
        Effect.sync(() => {
          calls.push(["note", message]);
        }),
    };

    return Effect.gen(function* () {
      const branchProvider = yield* PrismaBranch.Provider;
      yield* branchProvider.delete({
        id: "MainBranch",
        instanceId: "00000000000000000000000000000000",
        olds: {} as never,
        output: {
          branchId: "branch-1",
          projectId: "project-1",
          isDefault: false,
        },
        session,
        bindings: [],
      } as never);

      expect(calls).toEqual([
        ["getBranch", "branch-1"],
        [
          "note",
          "Skipping direct delete for default Prisma branch; Prisma removes it when the owning project is deleted.",
        ],
      ]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("skips default Prisma branch delete without a session", () => {
    const calls: Call[] = [];
    const client = {
      getBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["getBranch", id]);
          return { id, isDefault: true };
        }),
      deleteBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteBranch", id]);
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const branchProvider = yield* PrismaBranch.Provider;
      yield* branchProvider.delete({
        id: "MainBranch",
        instanceId: "00000000000000000000000000000000",
        olds: {} as never,
        output: {
          branchId: "branch-1",
          projectId: "project-1",
          isDefault: true,
        },
        session: undefined,
        bindings: [],
      } as never);

      expect(calls).toEqual([["getBranch", "branch-1"]]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("deletes a branch when stale state says it is default", () => {
    const calls: Call[] = [];
    const client = {
      getBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["getBranch", id]);
          return { id, isDefault: false };
        }),
      deleteBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteBranch", id]);
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const branchProvider = yield* PrismaBranch.Provider;
      yield* branchProvider.delete({
        id: "MainBranch",
        instanceId: "00000000000000000000000000000000",
        olds: {} as never,
        output: {
          branchId: "branch-1",
          projectId: "project-1",
          isDefault: true,
        },
        session: undefined,
        bindings: [],
      } as never);

      expect(calls).toEqual([
        ["getBranch", "branch-1"],
        ["deleteBranch", "branch-1"],
      ]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("re-reads resources after create conflict races", () => {
    const calls: Call[] = [];
    const visible = new Set<string>();
    const conflict = (path: string) =>
      new PrismaApiError({
        method: "POST",
        path,
        status: 409,
        message: "already exists",
      });
    const project = {
      id: "project-1",
      type: "project" as const,
      url: "https://api.prisma.test/v1/projects/project-1",
      name: "app",
      createdAt,
      defaultRegion: "us-east-1",
      workspace: resourceRef("workspaces", "workspace-1", "team"),
    };
    const database = {
      id: "database-1",
      type: "database" as const,
      url: "https://api.prisma.test/v1/databases/database-1",
      name: "main",
      status: "ready" as const,
      createdAt,
      isDefault: false,
      defaultConnectionId: "connection-1",
      connections: [],
      project: resourceRef("projects", "project-1", "app"),
      region: { id: "us-east-1", name: "US East" },
      source: { type: "empty" },
      branchId: null,
    };
    const connection = {
      id: "connection-1",
      type: "connection" as const,
      url: "https://api.prisma.test/v1/connections/connection-1",
      name: "api",
      createdAt,
      kind: "postgres" as const,
      endpoints: {
        direct: { host: "db.prisma.test", port: 5432 },
      },
      database: resourceRef("databases", "database-1", "main"),
    };
    const branch = {
      id: "branch-1",
      type: "branch" as const,
      url: "https://api.prisma.test/v1/branches/branch-1",
      gitName: "main",
      isDefault: false,
      createdAt,
      updatedAt,
      project: resourceRef("projects", "project-1", "app"),
    };
    const service = {
      id: "service-1",
      type: "compute-service" as const,
      url: "https://api.prisma.test/v1/compute-services/service-1",
      name: "api",
      region: { id: "us-east-1", name: "US East" },
      projectId: "project-1",
      branchId: null,
      latestVersionId: null,
      serviceEndpointDomain: "service-1.prisma.build",
      createdAt,
    };
    const variable = {
      id: "env-1",
      type: "environment-variable" as const,
      url: "https://api.prisma.test/v1/environment-variables/env-1",
      projectId: "project-1",
      branchId: null,
      class: "production" as const,
      key: "TOKEN",
      valueKid: "kid-1",
      isManagedBySystem: false,
      createdAt,
      updatedAt,
    };
    const repo = {
      id: "repo-1",
      type: "source-repository" as const,
      url: "https://api.prisma.test/v1/source-repositories/repo-1",
      repoId: 123,
      provider: "github" as const,
      repoFullName: "acme/api",
      defaultBranch: "main",
      isPrivate: true,
      status: "active" as const,
      projectId: "project-1",
      installationId: "installation-1",
      createdAt,
      updatedAt,
    };

    const client = {
      listProjects: () =>
        Effect.sync(() => {
          calls.push(["listProjects"]);
          return visible.has("project") ? [project] : [];
        }),
      createProject: (input: unknown) =>
        Effect.gen(function* () {
          calls.push(["createProject", input]);
          visible.add("project");
          return yield* Effect.fail(conflict("/v1/projects"));
        }),
      listProjectDatabases: (projectId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listProjectDatabases", { projectId, query }]);
          return visible.has("database") ? [database] : [];
        }),
      createDatabase: (input: unknown) =>
        Effect.gen(function* () {
          calls.push(["createDatabase", input]);
          visible.add("database");
          return yield* Effect.fail(conflict("/v1/databases"));
        }),
      listDatabaseConnections: (databaseId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listDatabaseConnections", { databaseId, query }]);
          return visible.has("connection") ? [connection] : [];
        }),
      createConnection: (input: unknown) =>
        Effect.gen(function* () {
          calls.push(["createConnection", input]);
          visible.add("connection");
          return yield* Effect.fail(conflict("/v1/connections"));
        }),
      rotateConnection: (id: string) =>
        Effect.sync(() => {
          calls.push(["rotateConnection", id]);
          return {
            ...connection,
            endpoints: {
              direct: {
                host: "db.prisma.test",
                port: 5432,
                connectionString: "postgres://rotated-direct",
              },
            },
            directConnection: {
              host: "db.prisma.test",
              user: "app",
              pass: "rotated-password",
            },
          };
        }),
      listBranches: (projectId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listBranches", { projectId, query }]);
          return visible.has("branch") ? [branch] : [];
        }),
      createBranch: (projectId: string, input: unknown) =>
        Effect.gen(function* () {
          calls.push(["createBranch", { projectId, input }]);
          visible.add("branch");
          return yield* Effect.fail(
            conflict(`/v1/projects/${projectId}/branches`),
          );
        }),
      listProjectComputeServices: (projectId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listProjectComputeServices", { projectId, query }]);
          return visible.has("service") ? [service] : [];
        }),
      createProjectComputeService: (projectId: string, input: unknown) =>
        Effect.gen(function* () {
          calls.push(["createProjectComputeService", { projectId, input }]);
          visible.add("service");
          return yield* Effect.fail(
            conflict(`/v1/projects/${projectId}/compute-services`),
          );
        }),
      listEnvironmentVariables: (query: unknown) =>
        Effect.sync(() => {
          calls.push(["listEnvironmentVariables", query]);
          return visible.has("env") ? [variable] : [];
        }),
      createEnvironmentVariable: (input: unknown) =>
        Effect.gen(function* () {
          calls.push(["createEnvironmentVariable", input]);
          visible.add("env");
          return yield* Effect.fail(conflict("/v1/environment-variables"));
        }),
      updateEnvironmentVariable: (id: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["updateEnvironmentVariable", { id, input }]);
          return variable;
        }),
      listSourceRepositories: (query: unknown) =>
        Effect.sync(() => {
          calls.push(["listSourceRepositories", query]);
          return visible.has("repo") ? [repo] : [];
        }),
      createSourceRepository: (input: unknown) =>
        Effect.gen(function* () {
          calls.push(["createSourceRepository", input]);
          visible.add("repo");
          return yield* Effect.fail(conflict("/v1/source-repositories"));
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const projectProvider = yield* PrismaProject.Provider;
      const databaseProvider = yield* PrismaDatabase.Provider;
      const connectionProvider = yield* PrismaConnection.Provider;
      const branchProvider = yield* PrismaBranch.Provider;
      const serviceProvider = yield* PrismaComputeService.Provider;
      const envProvider = yield* PrismaEnvironmentVariable.Provider;
      const repoProvider = yield* PrismaSourceRepository.Provider;

      const projectOut = yield* projectProvider.reconcile(
        reconcileInput("Project", { name: "app", createDatabase: false }),
      );
      const databaseOut = yield* databaseProvider.reconcile(
        reconcileInput("Database", { project: "project-1", name: "main" }),
      );
      const connectionOut = yield* connectionProvider.reconcile(
        reconcileInput("Connection", {
          database: "database-1",
          name: "api",
          rotate: true,
        }),
      );
      const branchOut = yield* branchProvider.reconcile(
        reconcileInput("Branch", { project: "project-1", gitName: "main" }),
      );
      const serviceOut = yield* serviceProvider.reconcile(
        reconcileInput("ComputeService", {
          project: "project-1",
          displayName: "api",
        }),
      );
      const envOut = yield* envProvider.reconcile(
        reconcileInput("EnvironmentVariable", {
          project: "project-1",
          class: "production" as const,
          key: "TOKEN",
          value: "secret",
        }),
      );
      const repoOut = yield* repoProvider.reconcile(
        reconcileInput("SourceRepository", {
          project: "project-1",
          providerRepositoryId: 123,
        }),
      );

      expect(projectOut.projectId).toBe("project-1");
      expect(databaseOut.databaseId).toBe("database-1");
      expect(connectionOut.connectionId).toBe("connection-1");
      expect(Redacted.value(connectionOut.directConnectionString!)).toBe(
        "postgres://rotated-direct",
      );
      expect(Redacted.value(connectionOut.password!)).toBe("rotated-password");
      expect(branchOut.branchId).toBe("branch-1");
      expect(serviceOut.computeServiceId).toBe("service-1");
      expect(envOut.environmentVariableId).toBe("env-1");
      expect(repoOut.sourceRepositoryId).toBe("repo-1");
      expect(calls.filter(([name]) => name.startsWith("create"))).toEqual([
        [
          "createProject",
          { name: "app", createDatabase: false, region: "us-east-1" },
        ],
        [
          "createDatabase",
          {
            projectId: "project-1",
            name: "main",
            region: "us-east-1",
            isDefault: false,
            source: undefined,
            branchId: undefined,
            branchGitName: undefined,
          },
        ],
        ["createConnection", { databaseId: "database-1", name: "api" }],
        [
          "createBranch",
          {
            projectId: "project-1",
            input: { gitName: "main", isDefault: undefined },
          },
        ],
        [
          "createProjectComputeService",
          {
            projectId: "project-1",
            input: {
              displayName: "api",
              regionId: "us-east-1",
              branchId: undefined,
              branchGitName: undefined,
            },
          },
        ],
        [
          "createEnvironmentVariable",
          {
            projectId: "project-1",
            class: "production",
            key: "TOKEN",
            value: "secret",
          },
        ],
        [
          "createSourceRepository",
          {
            projectId: "project-1",
            provider: "github",
            providerRepositoryId: 123,
          },
        ],
      ]);
      expect(calls).toContainEqual([
        "updateEnvironmentVariable",
        { id: "env-1", input: { value: "secret" } },
      ]);
      expect(calls).toContainEqual(["rotateConnection", "connection-1"]);
    }).pipe(
      Effect.provide(providerLayer(client)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(Stack, {
        name: "prisma-provider-conflict-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "test"),
    );
  });
});
