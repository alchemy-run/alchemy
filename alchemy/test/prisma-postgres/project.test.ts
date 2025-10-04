import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { destroy } from "../../src/destroy.ts";
import { Database } from "../../src/prisma/postgres/database.ts";
import type { Database as DatabaseOutput } from "../../src/prisma/postgres/database.ts";
import { DatabaseBackups } from "../../src/prisma/postgres/database-backups.ts";
import { DatabaseConnection } from "../../src/prisma/postgres/database-connection.ts";
import type { DatabaseConnection as DatabaseConnectionOutput } from "../../src/prisma/postgres/database-connection.ts";
import { PrismaPostgresApi } from "../../src/prisma/postgres/api.ts";
import { Project } from "../../src/prisma/postgres/project.ts";
import type { Project as ProjectOutput } from "../../src/prisma/postgres/project.ts";
import { Workspace } from "../../src/prisma/postgres/workspace.ts";
import { BRANCH_PREFIX } from "../util.ts";
import "../../src/test/vitest.ts";

const hasToken = Boolean(process.env.PRISMA_SERVICE_TOKEN);

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe.skipIf(!hasToken)("Prisma Postgres", () => {
  test("project, database and connections lifecycle", async (scope) => {
    const projectName = `${BRANCH_PREFIX}-prisma-project`;
    const databaseName = `${BRANCH_PREFIX}-database`;
    const connectionName = `${BRANCH_PREFIX}-connection`;

    const api = new PrismaPostgresApi();
    let project: ProjectOutput | undefined;
    let database: DatabaseOutput | undefined;
    let connection: DatabaseConnectionOutput | undefined;

    try {
      const workspaces = await api.listWorkspaces();
      expect(workspaces.data.length).toBeGreaterThan(0);

      const workspace = await Workspace("workspace", {
        id: workspaces.data[0]!.id,
      });

      expect(workspace).toMatchObject({
        id: workspaces.data[0]!.id,
        name: expect.any(String),
        createdAt: expect.any(String),
      });

      project = await Project("project", {
        name: projectName,
        region: "us-east-1",
        createDatabase: false,
      });

      expect(project).toMatchObject({
        id: expect.any(String),
        name: projectName,
        region: "us-east-1",
        createDatabase: false,
      });

      database = await Database("database", {
        project,
        name: databaseName,
        region: "us-east-1",
        adopt: false,
      });

      expect(database.id).toMatch(/^db_/);
      expect(database.name).toBe(databaseName);
      expect(database.connectionString).toBeDefined();
      expect(database.project.name).toBe(project.name);
      expect(database.project.id.endsWith(project.id)).toBe(true);

      connection = await DatabaseConnection("connection", {
        database,
        name: connectionName,
      });

      expect(connection).toMatchObject({
        id: expect.stringMatching(/^con_/),
        name: connectionName,
        database: {
          id: database.id,
          name: database.name,
        },
      });
      expect(connection.connectionString.unencrypted).toMatch(
        /^prisma\+postgres:\/\//,
      );

      const backups = await DatabaseBackups("backups", {
        database,
        limit: 5,
      });

      expect(backups).toMatchObject({
        databaseId: database.id,
        backups: expect.any(Array),
        meta: {
          backupRetentionDays: expect.any(Number),
        },
      });
    } finally {
      await destroy(scope);

      if (connection) {
        await assertConnectionDeleted(api, connection.id, database?.id);
      }
      if (database) {
        await assertDatabaseDeleted(api, database.id);
      }
      if (project) {
        await assertProjectDeleted(api, project.id);
      }
    }
  }, 240_000);
});

async function assertProjectDeleted(api: PrismaPostgresApi, projectId: string) {
  const project = await api.getProject(projectId);
  expect(project).toBeUndefined();
}

async function assertDatabaseDeleted(
  api: PrismaPostgresApi,
  databaseId: string,
) {
  const database = await api.getDatabase(databaseId);
  expect(database).toBeUndefined();
}

async function assertConnectionDeleted(
  api: PrismaPostgresApi,
  connectionId: string,
  databaseId?: string,
) {
  if (!databaseId) {
    return;
  }
  const existing = await api.listConnections(databaseId);
  const found = existing.data.find(
    (connection) => connection.id === connectionId,
  );
  expect(found).toBeUndefined();
}
