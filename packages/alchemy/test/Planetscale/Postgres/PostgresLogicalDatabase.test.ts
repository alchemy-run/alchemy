import * as Planetscale from "@/Planetscale";
import * as Provider from "@/Provider.ts";
import * as State from "@/State";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { beforeEach, vi } from "vitest";

const mockClient = vi.hoisted(function createMockClient() {
  type Owner = {
    readonly logicalId: string;
    readonly resourceType: string;
    readonly version: number;
  };
  type DatabaseState = {
    appRolePrivilegeHash?: string;
    appRolePrivilegesReady: boolean;
    owner?: Owner;
    tracked: Record<string, Record<string, string>>;
  };
  type SqlFile = {
    readonly id: string;
    readonly hash: string;
    readonly sql: string;
  };

  const databases = new Map<string, DatabaseState>();

  const getDatabase = (databaseName: string) => {
    const database = databases.get(databaseName);
    if (!database) {
      throw new Error(`Database ${databaseName} does not exist`);
    }
    return database;
  };

  const databaseExists = vi.fn(async (_origin: unknown, databaseName: string) =>
    databases.has(databaseName),
  );
  const ensureDatabase = vi.fn(
    async (_origin: unknown, databaseName: string) => {
      if (!databases.has(databaseName)) {
        databases.set(databaseName, {
          appRolePrivilegesReady: false,
          tracked: {},
        });
      }
    },
  );
  const dropDatabase = vi.fn(async (_origin: unknown, databaseName: string) => {
    databases.delete(databaseName);
  });
  const ensureDatabaseOwnership = vi.fn(
    async (input: { databaseName: string; owner: Owner }) => {
      getDatabase(input.databaseName).owner = input.owner;
    },
  );
  const readDatabaseOwnership = vi.fn(
    async (input: { databaseName: string }) =>
      getDatabase(input.databaseName).owner,
  );
  const readTrackedSqlFileHashes = vi.fn(
    async (input: { databaseName: string; tableName: string }) =>
      getDatabase(input.databaseName).tracked[input.tableName] ?? {},
  );
  const removedRecordNames = (
    files: readonly Pick<SqlFile, "id">[],
    existingRecords: Record<string, string>,
  ) => {
    const desiredNames = new Set(files.map((file) => file.id));
    return Object.keys(existingRecords)
      .filter((name) => !desiredNames.has(name))
      .sort();
  };
  const applyTrackedSqlFiles = vi.fn(
    async function applyTrackedSqlFiles(input: {
      changedFileAction: "reject" | "reapply";
      databaseName: string;
      files: readonly SqlFile[];
      tableName: string;
    }) {
      const database = getDatabase(input.databaseName);
      const existingRecords = database.tracked[input.tableName] ?? {};
      const removedNames = removedRecordNames(input.files, existingRecords);

      if (removedNames.length > 0) {
        throw new Error(
          `Refusing to remove tracked SQL file records from ${input.tableName}: ${removedNames.join(
            ", ",
          )}. Create a new forward migration/import instead.`,
        );
      }

      for (const file of input.files) {
        const existingHash = existingRecords[file.id];
        if (
          existingHash &&
          existingHash !== file.hash &&
          input.changedFileAction === "reject"
        ) {
          throw new Error(
            `Refusing to reapply changed SQL file ${file.id}; create a new migration/import file instead.`,
          );
        }
        existingRecords[file.id] = file.hash;
      }

      database.tracked[input.tableName] = existingRecords;
    },
  );
  const ensureAppRolePrivileges = vi.fn(
    async (input: {
      databaseName: string;
      excludedTableNames: readonly string[];
      roleName: string;
    }) => {
      const database = getDatabase(input.databaseName);
      database.appRolePrivilegesReady = true;
      database.appRolePrivilegeHash = JSON.stringify({
        excludedTableNames: [...input.excludedTableNames].sort(),
        roleName: input.roleName,
      });
    },
  );
  const readAppRolePrivileges = vi.fn(
    async (input: { databaseName: string }) => {
      const database = getDatabase(input.databaseName);
      return {
        hash: database.appRolePrivilegeHash ?? "missing",
        ready: database.appRolePrivilegesReady,
      };
    },
  );

  return {
    applyTrackedSqlFiles,
    databaseExists,
    databases,
    dropDatabase,
    ensureAppRolePrivileges,
    ensureDatabase,
    ensureDatabaseOwnership,
    readAppRolePrivileges,
    readDatabaseOwnership,
    readTrackedSqlFileHashes,
    reset() {
      databases.clear();
      for (const value of [
        applyTrackedSqlFiles,
        databaseExists,
        dropDatabase,
        ensureAppRolePrivileges,
        ensureDatabase,
        ensureDatabaseOwnership,
        readAppRolePrivileges,
        readDatabaseOwnership,
        readTrackedSqlFileHashes,
      ]) {
        value.mockClear();
      }
    },
  };
});

vi.mock("@/Planetscale/Postgres/PostgresLogicalDatabaseClient.ts", () => ({
  applyTrackedSqlFiles: mockClient.applyTrackedSqlFiles,
  databaseExists: mockClient.databaseExists,
  dropDatabase: mockClient.dropDatabase,
  ensureAppRolePrivileges: mockClient.ensureAppRolePrivileges,
  ensureDatabase: mockClient.ensureDatabase,
  ensureDatabaseOwnership: mockClient.ensureDatabaseOwnership,
  readAppRolePrivileges: mockClient.readAppRolePrivileges,
  readDatabaseOwnership: mockClient.readDatabaseOwnership,
  readTrackedSqlFileHashes: mockClient.readTrackedSqlFileHashes,
}));

const providers = () =>
  Layer.effect(
    Planetscale.Providers,
    Provider.collection([Planetscale.PostgresLogicalDatabase]),
  ).pipe(
    Layer.provide(Planetscale.PostgresLogicalDatabaseProvider()),
    Layer.orDie,
  );

const { test } = Test.make({ providers: providers() });

beforeEach(() => {
  mockClient.reset();
});

const origin = (): Planetscale.PostgresOrigin => ({
  database: "postgres",
  host: "localhost",
  password: Redacted.make("secret"),
  port: 5432,
  scheme: "postgres",
  user: "postgres",
});

const makeSqlDir = () => {
  const root = mkdtempSync(path.join(tmpdir(), "alchemy-postgres-logical-"));
  const migrationsDir = path.join(root, "migrations");
  mkdirSync(migrationsDir);
  const firstMigration = path.join(migrationsDir, "001_init.sql");
  writeFileSync(firstMigration, "SELECT 1;\n");

  return {
    firstMigration,
    migrationsDir,
    root,
  };
};

const cleanupSqlDir = (root: string) =>
  Effect.sync(() => rmSync(root, { force: true, recursive: true })).pipe(
    Effect.orDie,
  );

const logicalDatabase = (input: {
  readonly adminOrigin: Planetscale.PostgresOrigin;
  readonly appRoleName?: string;
  readonly appRolePrivilegesVersion?: number;
  readonly migrationsDir: string;
  readonly name: string;
}) => Planetscale.PostgresLogicalDatabase("TestDatabase", input);

const failureText = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.match(exit, {
    onFailure: Cause.pretty,
    onSuccess: () => "",
  });

test.provider(
  "recovers partial creating state without readable props",
  (stack) => {
    const sqlDir = makeSqlDir();

    return Effect.gen(function* () {
      const state = yield* yield* State.State;

      yield* state.set({
        fqn: "TestDatabase",
        stack: stack.name,
        stage: "test",
        value: {
          bindings: [],
          downstream: [],
          fqn: "TestDatabase",
          instanceId: "partial-create",
          logicalId: "TestDatabase",
          namespace: undefined,
          props: {
            appRolePrivilegesVersion: 1,
            migrationsDir: sqlDir.migrationsDir,
            migrationsTable: "__alchemy_migrations",
          },
          providerVersion: 0,
          removalPolicy: "destroy",
          resourceType: "Planetscale.PostgresLogicalDatabase",
          status: "creating",
        },
      });

      const recovered = yield* stack.deploy(
        logicalDatabase({
          adminOrigin: origin(),
          appRoleName: "pscale_api_app",
          migrationsDir: sqlDir.migrationsDir,
          name: "alchemy_test",
        }),
      );

      expect(recovered.name).toBe("alchemy_test");
      expect(mockClient.databaseExists).not.toHaveBeenCalled();
      expect(mockClient.ensureDatabase).toHaveBeenCalledWith(
        expect.any(Object),
        "alchemy_test",
      );
      expect(mockClient.databases.has("alchemy_test")).toBe(true);
    }).pipe(Effect.ensuring(cleanupSqlDir(sqlDir.root)));
  },
  { timeout: 120_000 },
);

test.provider(
  "creates, updates, and deletes a logical database",
  (stack) => {
    const sqlDir = makeSqlDir();

    return Effect.gen(function* () {
      const first = yield* stack.deploy(
        logicalDatabase({
          adminOrigin: origin(),
          appRoleName: "pscale_api_app",
          migrationsDir: sqlDir.migrationsDir,
          name: "alchemy_test",
        }),
      );

      expect(first.name).toBe("alchemy_test");
      expect(first.owner).toEqual({
        logicalId: "TestDatabase",
        resourceType: "Planetscale.PostgresLogicalDatabase",
        version: 1,
      });
      expect(first.ownershipTable).toBe("__alchemy_logical_database_ownership");
      expect(mockClient.databases.has("alchemy_test")).toBe(true);
      expect(mockClient.ensureDatabaseOwnership).toHaveBeenCalledOnce();
      expect(mockClient.ensureAppRolePrivileges).toHaveBeenCalledWith(
        expect.objectContaining({
          excludedTableNames: expect.arrayContaining([
            "__alchemy_imports",
            "__alchemy_logical_database_ownership",
            "__alchemy_migrations",
          ]),
          roleName: "pscale_api_app",
        }),
      );

      const second = yield* stack.deploy(
        logicalDatabase({
          adminOrigin: origin(),
          appRoleName: "pscale_api_app",
          appRolePrivilegesVersion: 2,
          migrationsDir: sqlDir.migrationsDir,
          name: "alchemy_test",
        }),
      );

      expect(second.name).toBe(first.name);
      expect(second.appRolePrivilegesVersion).toBe(2);
      expect(mockClient.dropDatabase).not.toHaveBeenCalled();

      yield* stack.destroy();

      expect(
        mockClient.dropDatabase.mock.calls.map(([, name]) => name),
      ).toContain("alchemy_test");
      expect(mockClient.databases.has("alchemy_test")).toBe(false);
    }).pipe(Effect.ensuring(cleanupSqlDir(sqlDir.root)));
  },
  { timeout: 120_000 },
);

test.provider(
  "rejects logical database renames",
  (stack) => {
    const sqlDir = makeSqlDir();

    return Effect.gen(function* () {
      yield* stack.deploy(
        logicalDatabase({
          adminOrigin: origin(),
          migrationsDir: sqlDir.migrationsDir,
          name: "alchemy_test",
        }),
      );

      const renameExit = yield* Effect.exit(
        stack.deploy(
          logicalDatabase({
            adminOrigin: origin(),
            migrationsDir: sqlDir.migrationsDir,
            name: "alchemy_test_renamed",
          }),
        ),
      );

      expect(Exit.isFailure(renameExit)).toBe(true);
      expect(failureText(renameExit)).toContain(
        "Refusing to rename logical Postgres database",
      );
      expect(mockClient.dropDatabase).not.toHaveBeenCalled();
    }).pipe(Effect.ensuring(cleanupSqlDir(sqlDir.root)));
  },
  { timeout: 120_000 },
);

test.provider(
  "rejects removed tracked SQL files",
  (stack) => {
    const sqlDir = makeSqlDir();

    return Effect.gen(function* () {
      yield* stack.deploy(
        logicalDatabase({
          adminOrigin: origin(),
          migrationsDir: sqlDir.migrationsDir,
          name: "alchemy_test",
        }),
      );

      unlinkSync(sqlDir.firstMigration);

      const removeExit = yield* Effect.exit(
        stack.deploy(
          logicalDatabase({
            adminOrigin: origin(),
            migrationsDir: sqlDir.migrationsDir,
            name: "alchemy_test",
          }),
        ),
      );

      expect(Exit.isFailure(removeExit)).toBe(true);
      expect(failureText(removeExit)).toContain(
        "Refusing to remove tracked SQL file records",
      );
    }).pipe(Effect.ensuring(cleanupSqlDir(sqlDir.root)));
  },
  { timeout: 120_000 },
);
