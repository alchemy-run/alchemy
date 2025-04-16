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
        adopt: true,
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

  test("primary location hint", async (scope) => {
    const locationDb = `${testId}-location`;

    try {
      // Create a database with West North America location hint
      const database = await D1Database(locationDb, {
        name: locationDb,
        primaryLocationHint: "wnam", // West North America
        adopt: true,
      });

      expect(database.name).toEqual(locationDb);
      expect(database.id).toBeTruthy();
      expect(database.primaryLocationHint).toEqual("wnam");

      // Check if database exists
      const databases = await listDatabases(api);
      const foundDatabase = databases.find((db) => db.name === locationDb);
      expect(foundDatabase).toBeTruthy();
    } finally {
      await alchemy.destroy(scope);
    }
  }, 120000);

  test("update read replication mode", async (scope) => {
    const replicationDb = `${testId}-replication`;

    try {
      // Create a database with default settings
      let database = await D1Database(replicationDb, {
        name: replicationDb,
        adopt: true,
      });

      expect(database.name).toEqual(replicationDb);
      expect(database.id).toBeTruthy();

      // Update the database with disabled read replication
      database = await D1Database(replicationDb, {
        name: replicationDb,
        readReplication: {
          mode: "disabled",
        },
        adopt: true,
      });

      // Verify the update
      expect(database.readReplication?.mode).toEqual("disabled");
    } finally {
      await alchemy.destroy(scope);
    }
  }, 120000);

  test("throws error on invalid update", async (scope) => {
    const invalidUpdateDb = `${testId}-invalid-update`;

    try {
      // Create a database with West North America location hint
      const database = await D1Database(invalidUpdateDb, {
        name: invalidUpdateDb,
        primaryLocationHint: "wnam", // West North America
        adopt: true,
      });

      expect(database.name).toEqual(invalidUpdateDb);
      expect(database.id).toBeTruthy();
      expect(database.primaryLocationHint).toEqual("wnam");

      // Attempt to update with a different location hint, which should throw an error
      await expect(
        D1Database(invalidUpdateDb, {
          name: invalidUpdateDb,
          primaryLocationHint: "eeur", // East Europe - different from original
          adopt: true,
        })
      ).rejects.toThrow("Cannot update primaryLocationHint");
    } finally {
      await alchemy.destroy(scope);
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
