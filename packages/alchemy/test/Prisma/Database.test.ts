import { AlchemyContext } from "@/AlchemyContext";
import { InstanceId } from "@/InstanceId";
import { PrismaClient, type PrismaManagementClient } from "@/Prisma/Client";
import {
  Database as PrismaDatabase,
  DatabaseProvider,
} from "@/Prisma/Database";
import type { Database as ApiDatabase } from "@/Prisma/Types";
import { Stack } from "@/Stack";
import { Stage } from "@/Stage";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const createdAt = "2026-01-01T00:00:00.000Z";
const instanceId = "00000000000000000000000000000000";

const branch = (id: string, isDefault = true) => ({
  id,
  type: "branch" as const,
  url: `https://api.prisma.test/v1/branches/${id}`,
  gitName: "main",
  isDefault,
  role: "production" as const,
  createdAt,
  updatedAt: createdAt,
  project: {
    id: "project-1",
    url: "https://api.prisma.test/v1/projects/project-1",
    name: "app",
  },
});

const connection = (databaseId: string) => ({
  id: `connection-${databaseId}`,
  type: "connection" as const,
  url: `https://api.prisma.test/v1/connections/connection-${databaseId}`,
  name: "default",
  createdAt,
  kind: "postgres" as const,
  endpoints: {
    direct: {
      host: "db.prisma.test",
      port: 5432,
      connectionString: `postgres://direct-${databaseId}`,
    },
    pooled: {
      host: "pool.prisma.test",
      port: 5432,
      connectionString: `postgres://pooled-${databaseId}`,
    },
  },
  database: {
    id: databaseId,
    url: `https://api.prisma.test/v1/databases/${databaseId}`,
    name: "db",
  },
});

const database = (
  id: string,
  branchId: string | null,
  overrides: Partial<ApiDatabase> = {},
): ApiDatabase => ({
  id,
  type: "database",
  url: `https://api.prisma.test/v1/databases/${id}`,
  name: "db",
  status: "ready",
  createdAt,
  isDefault: false,
  defaultConnectionId: `connection-${id}`,
  connections: [connection(id)],
  project: {
    id: "project-1",
    url: "https://api.prisma.test/v1/projects/project-1",
    name: "app",
  },
  region: { id: "us-east-1", name: "US East" },
  source: { type: "empty" },
  branchId,
  ...overrides,
});

const attrs = (
  databaseId: string,
  branchId: string | null,
): PrismaDatabase["Attributes"] => ({
  databaseId,
  databaseName: "db",
  projectId: "project-1",
  status: "ready",
  region: "us-east-1",
  isDefault: false,
  branchId,
  defaultConnectionId: `connection-${databaseId}`,
  createdAt,
  directConnectionString: undefined,
  pooledConnectionString: undefined,
  accelerateConnectionString: undefined,
  host: undefined,
  user: undefined,
  password: undefined,
});

const liveProviderContext = Layer.succeed(AlchemyContext, {
  dotAlchemy: ".alchemy-test",
  dev: false,
  adopt: false,
});

const provide =
  (client: PrismaManagementClient) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(DatabaseProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(liveProviderContext),
      Effect.provideService(Stack, {
        name: "prisma-database-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "test"),
      Effect.provideService(InstanceId, instanceId),
    );

const reconcileInput = (news: unknown, output?: unknown, olds?: unknown) =>
  ({
    id: "Database",
    fqn: "Database",
    instanceId,
    news,
    olds,
    output,
    session: undefined as never,
    bindings: [],
  }) as never;

const diffInput = (olds: unknown, news: unknown, output?: unknown) =>
  ({
    id: "Database",
    fqn: "Database",
    instanceId,
    olds,
    news,
    output,
    oldBindings: [],
    newBindings: [],
  }) as never;

describe("Prisma Database", () => {
  it.effect(
    "attaches a generated-name create to the project's default branch",
    () => {
      const calls: Array<[string, unknown?]> = [];
      const client = {
        listBranches: () => Effect.succeed([branch("branch-main")]),
        listProjectDatabases: () => Effect.succeed([]),
        createDatabase: (input: { name?: string; branchId?: string }) =>
          Effect.sync(() => {
            calls.push(["createDatabase", input]);
            return database("database-1", input.branchId ?? null, {
              name: input.name,
            });
          }),
        updateDatabase: () =>
          Effect.die("a create born attached must not be patched"),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* PrismaDatabase.Provider;
        const output = yield* provider.reconcile(
          reconcileInput({ project: "project-1" }),
        );

        expect(output.branchId).toBe("branch-main");
        expect(calls.map(([name]) => name)).toEqual(["createDatabase"]);
        expect(calls[0]?.[1]).toMatchObject({ branchId: "branch-main" });
      }).pipe(provide(client));
    },
  );

  it.effect(
    "never detaches a database already attached to the default branch",
    () => {
      const client = {
        getDatabase: () =>
          Effect.succeed(database("database-1", "branch-main")),
        listBranches: () => Effect.succeed([branch("branch-main")]),
        updateDatabase: () =>
          Effect.die("omitted branch props must not detach the database"),
      } as unknown as PrismaManagementClient;
      const props = { project: "project-1", name: "db" };

      return Effect.gen(function* () {
        const provider = yield* PrismaDatabase.Provider;
        const output = yield* provider.reconcile(
          reconcileInput(props, attrs("database-1", "branch-main"), props),
        );
        expect(output.databaseId).toBe("database-1");
        expect(output.branchId).toBe("branch-main");

        const clean = yield* provider.diff!(
          diffInput(props, props, attrs("database-1", "branch-main")),
        );
        expect(clean).toBeUndefined();
      }).pipe(provide(client));
    },
  );

  it.effect(
    "converges a pre-existing unassigned database onto the default branch in place",
    () => {
      const calls: Array<[string, unknown?]> = [];
      let observed = database("database-1", null);
      const client = {
        getDatabase: () => Effect.sync(() => observed),
        listBranches: () => Effect.succeed([branch("branch-main")]),
        updateDatabase: (id: string, input: { branchId?: string | null }) =>
          Effect.sync(() => {
            calls.push(["updateDatabase", { id, input }]);
            observed = database(id, input.branchId ?? null);
            return observed;
          }),
      } as unknown as PrismaManagementClient;
      const props = { project: "project-1", name: "db" };

      return Effect.gen(function* () {
        const provider = yield* PrismaDatabase.Provider;
        const plan = yield* provider.diff!(
          diffInput(props, props, attrs("database-1", null)),
        );
        expect(plan).toEqual({ action: "update" });

        const output = yield* provider.reconcile(
          reconcileInput(props, attrs("database-1", null), props),
        );
        expect(output.databaseId).toBe("database-1");
        expect(output.branchId).toBe("branch-main");
        expect(calls).toEqual([
          [
            "updateDatabase",
            {
              id: "database-1",
              input: {
                name: "db",
                branchId: "branch-main",
                branchGitName: undefined,
              },
            },
          ],
        ]);
      }).pipe(provide(client));
    },
  );

  it.effect("keeps an explicit branchId attachment authoritative", () => {
    const calls: Array<[string, unknown?]> = [];
    const client = {
      getDatabase: () => Effect.succeed(database("database-1", "branch-main")),
      updateDatabase: (id: string, input: { branchId?: string | null }) =>
        Effect.sync(() => {
          calls.push(["updateDatabase", { id, input }]);
          return database(id, input.branchId ?? null);
        }),
    } as unknown as PrismaManagementClient;
    const props = {
      project: "project-1",
      name: "db",
      branchId: "branch-feature",
    };

    return Effect.gen(function* () {
      const provider = yield* PrismaDatabase.Provider;
      const output = yield* provider.reconcile(
        reconcileInput(props, attrs("database-1", "branch-main"), props),
      );
      expect(output.branchId).toBe("branch-feature");
      expect(calls).toEqual([
        [
          "updateDatabase",
          {
            id: "database-1",
            input: {
              name: "db",
              branchId: "branch-feature",
              branchGitName: undefined,
            },
          },
        ],
      ]);
    }).pipe(provide(client));
  });

  it.effect("rejects explicit null branch props as unrepresentable", () => {
    const client = {} as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* PrismaDatabase.Provider;
      const reconcileError = yield* provider
        .reconcile(
          reconcileInput({
            project: "project-1",
            name: "db",
            branchGitName: null,
          }),
        )
        .pipe(Effect.flip);
      expect(String(reconcileError)).toContain("requires an attached branch");

      const diffError = yield* provider.diff!(
        diffInput(
          { project: "project-1", name: "db" },
          { project: "project-1", name: "db", branchId: null },
          attrs("database-1", "branch-main"),
        ),
      ).pipe(Effect.flip);
      expect(String(diffError)).toContain("requires an attached branch");
    }).pipe(provide(client));
  });

  it.effect("fails loudly when the project has no default branch", () => {
    const client = {
      listBranches: () => Effect.succeed([branch("branch-preview", false)]),
      listProjectDatabases: () => Effect.succeed([]),
      createDatabase: () =>
        Effect.die("must not create a database it cannot attach"),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* PrismaDatabase.Provider;
      const error = yield* provider
        .reconcile(reconcileInput({ project: "project-1" }))
        .pipe(Effect.flip);
      expect(String(error)).toContain(
        "has no default branch to attach database",
      );
      expect(String(error)).toContain("Create or promote a default branch");
    }).pipe(provide(client));
  });

  it.effect(
    "converges an explicitly named create onto the default branch in the same reconcile",
    () => {
      const calls: Array<[string, unknown?]> = [];
      const client = {
        listBranches: () => Effect.succeed([branch("branch-main")]),
        createDatabase: (input: { name?: string; branchId?: string }) =>
          Effect.sync(() => {
            calls.push(["createDatabase", input]);
            return database("database-1", input.branchId ?? null, {
              name: input.name,
            });
          }),
        updateDatabase: (id: string, input: { branchId?: string | null }) =>
          Effect.sync(() => {
            calls.push(["updateDatabase", { id, input }]);
            return database(id, input.branchId ?? null);
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* PrismaDatabase.Provider;
        const output = yield* provider.reconcile(
          reconcileInput({ project: "project-1", name: "db" }),
        );

        expect(output.branchId).toBe("branch-main");
        expect(calls.map(([name]) => name)).toEqual([
          "createDatabase",
          "updateDatabase",
        ]);
        // The Management API cannot create an explicitly named database with
        // an attachment atomically, so the create body carries no branch and
        // the PATCH in the same reconcile attaches the default branch.
        expect(calls[0]?.[1]).toMatchObject({ branchId: undefined });
        expect(calls[1]?.[1]).toMatchObject({
          input: { branchId: "branch-main" },
        });
      }).pipe(provide(client));
    },
  );
});
