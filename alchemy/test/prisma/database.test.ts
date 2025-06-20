import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { destroy } from "../../src/destroy.ts";
import { BRANCH_PREFIX } from "../util.ts";

import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Prisma Database", () => {
  test("PrismaDatabase", async (scope) => {
    const { PrismaProject } = await import("../../src/prisma/project.ts");
    const { PrismaDatabase } = await import("../../src/prisma/database.ts");

    const projectId = `${BRANCH_PREFIX}-prisma-db-project`;
    const databaseId = `${BRANCH_PREFIX}-prisma-database`;

    let project: any;
    let database: any;

    try {
      // First create a project
      project = await PrismaProject(projectId, {
        name: `DB Test Project ${BRANCH_PREFIX}`,
        description: "A test project for database testing",
      });

      expect(project.id).toBeDefined();

      // Create database
      database = await PrismaDatabase(databaseId, {
        project: project,
        name: `test-db-${BRANCH_PREFIX}`,
        region: "us-east-1",
        isDefault: false,
      });

      expect(database).toMatchObject({
        projectId: project.id,
        name: `test-db-${BRANCH_PREFIX}`,
        region: "us-east-1",
        isDefault: false,
      });

      expect(database.id).toBeDefined();
      expect(database.createdAt).toBeDefined();

      // Update (should return same database as most properties are immutable)
      database = await PrismaDatabase(databaseId, {
        project: project,
        name: `test-db-${BRANCH_PREFIX}`,
        region: "us-east-1",
        isDefault: false,
      });

      expect(database.id).toBeDefined();
      expect(database.projectId).toBe(project.id);
    } finally {
      await destroy(scope);
      await assertDatabaseDoesNotExist(project?.id, database?.id);
    }
  });
});

async function assertDatabaseDoesNotExist(
  projectId: string,
  databaseId: string,
) {
  if (!projectId || !databaseId) return;

  const { createPrismaApi } = await import("../../src/prisma/api.ts");
  const api = createPrismaApi();

  try {
    const response = await api.get(
      `/projects/${projectId}/databases/${databaseId}`,
    );
    if (response.ok) {
      throw new Error(
        `Database ${databaseId} still exists when it should have been deleted`,
      );
    }
  } catch (error) {
    // Expected - database should not exist
    if (error.message.includes("still exists")) {
      throw error;
    }
    // Other errors are expected (404, etc.)
  }
}
