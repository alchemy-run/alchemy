import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy";
import { createCloudflareApi } from "../../src/cloudflare/api";
import { D1Database, listDatabases } from "../../src/cloudflare/d1-database";
import "../../src/test/bun";
import { BRANCH_PREFIX } from "../util";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("D1 Database Resource", async () => {
  // Use BRANCH_PREFIX for deterministic, non-colliding resource names
  const testId = `${BRANCH_PREFIX}-test-db`;

  // Create Cloudflare API client for direct verification
  const api = await createCloudflareApi();

  test("create and delete database", async (scope) => {
    // Create a test database
    let database: D1Database | undefined = undefined;

    try {
      database = await D1Database(testId, {
        name: testId,
        primaryLocationHint: "wnam", // West North America
      });

      expect(database.name).toEqual(testId);
      expect(database.id).toBeTruthy();
      expect(database.fileSize).toBeNumber();
      expect(database.numTables).toBeNumber();
      expect(database.version).toBeTruthy();

      // Check if database exists by listing databases
      const databases = await listDatabases(api);
      const foundDatabase = databases.find((db) => db.name === testId);
      expect(foundDatabase).toBeTruthy();
      expect(foundDatabase?.id).toEqual(database.id);
    } finally {
      await alchemy.destroy(scope);

      // Verify database was deleted
      if (database) {
        await assertDatabaseDeleted(database);
      }
    }
  }, 120000);
});

async function assertDatabaseDeleted(database: D1Database) {
  const api = await createCloudflareApi();
  try {
    if (!database.id) {
      throw new Error("Database ID is undefined");
    }

    // Try to list databases and check if our database is still there
    const databases = await listDatabases(api);
    const foundDatabase = databases.find((db) => db.id === database.id);

    if (foundDatabase) {
      throw new Error(`Database ${database.name} was not deleted as expected`);
    }
  } catch (error: any) {
    // If we get a 404, the database was deleted
    if (error.status === 404) {
      return; // This is expected
    } else {
      throw new Error(`Unexpected error type: ${error}`);
    }
  }
}
