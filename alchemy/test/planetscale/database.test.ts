import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { destroy } from "../../src/destroy.ts";
import { PlanetScaleClient } from "../../src/planetscale/api/client.gen.ts";
import { Database } from "../../src/planetscale/database.ts";
import { waitForDatabaseReady } from "../../src/planetscale/utils.ts";
import { BRANCH_PREFIX } from "../util.ts";
// must import this or else alchemy.test won't exist
import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe.skipIf(!process.env.PLANETSCALE_TEST)("Database Resource", () => {
  const api = new PlanetScaleClient();
  const organizationId = alchemy.env.PLANETSCALE_ORG_ID;

  test("create database with minimal settings", async (scope) => {
    const name = `${BRANCH_PREFIX}-basic`;

    try {
      const database = await Database("basic", {
        name,
        organizationId,
        clusterSize: "PS_10",
      });

      expect(database).toMatchObject({
        id: expect.any(String),
        name,
        defaultBranch: "main",
        organizationId,
        state: expect.any(String),
        plan: expect.any(String),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        htmlUrl: expect.any(String),
      });

      // Branch won't exist until database is ready
      await waitForDatabaseReady(api, organizationId, name);

      // Verify main branch cluster size
      const mainBranchResponse = await api.organizations.databases.branches.get(
        {
          path: {
            organization: organizationId,
            database: name,
            name: "main",
          },
        },
      );

      expect(mainBranchResponse.cluster_name).toEqual("PS_10");
    } finally {
      await destroy(scope);
      // Verify database was deleted by checking API directly
      await assertDatabaseDeleted(api, organizationId, name);
    }
  }, 600_000);

  test("create, update, and delete database", async (scope) => {
    const name = `${BRANCH_PREFIX}-crud`;
    let database;
    try {
      // Create test database with initial settings
      database = await Database("crud", {
        name,
        organizationId,
        region: {
          slug: "us-east",
        },
        clusterSize: "PS_10",
        allowDataBranching: true,
        automaticMigrations: true,
        requireApprovalForDeploy: false,
        restrictBranchRegion: true,
        insightsRawQueries: true,
        productionBranchWebConsole: true,
        defaultBranch: "main",
        migrationFramework: "rails",
        migrationTableName: "schema_migrations",
      });

      expect(database).toMatchObject({
        id: expect.any(String),
        name,
        organizationId,
        allowDataBranching: true,
        automaticMigrations: true,
        requireApprovalForDeploy: false,
        restrictBranchRegion: true,
        insightsRawQueries: true,
        productionBranchWebConsole: true,
        defaultBranch: "main",
        migrationFramework: "rails",
        migrationTableName: "schema_migrations",
        state: expect.any(String),
        plan: expect.any(String),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        htmlUrl: expect.any(String),
      });

      // Update database settings
      database = await Database("crud", {
        name,
        organizationId,
        clusterSize: "PS_20", // Change cluster size
        allowDataBranching: false,
        automaticMigrations: false,
        requireApprovalForDeploy: true,
        restrictBranchRegion: false,
        insightsRawQueries: false,
        productionBranchWebConsole: false,
        defaultBranch: "main",
        migrationFramework: "django",
        migrationTableName: "django_migrations",
      });

      expect(database).toMatchObject({
        allowDataBranching: false,
        automaticMigrations: false,
        requireApprovalForDeploy: true,
        restrictBranchRegion: false,
        insightsRawQueries: false,
        productionBranchWebConsole: false,
        defaultBranch: "main",
        migrationFramework: "django",
        migrationTableName: "django_migrations",
      });

      // Verify main branch cluster size was updated
      const mainBranchResponse = await api.organizations.databases.branches.get(
        {
          path: {
            organization: organizationId,
            database: name,
            name: "main",
          },
        },
      );
      expect(mainBranchResponse.cluster_name).toEqual("PS_20");
    } catch (err) {
      console.error("Test error:", err);
      throw err;
    } finally {
      // Cleanup
      await destroy(scope);

      // Verify database was deleted by checking API directly
      await assertDatabaseDeleted(api, organizationId, name);
    }
  }, 600_000); // this test takes forever as it needs to wait on multiple resizes!

  test("creates non-main default branch if specified", async (scope) => {
    const name = `${BRANCH_PREFIX}-create-branch`;
    const defaultBranch = "custom";
    try {
      // Create database with custom default branch
      const database = await Database("create-branch", {
        name,
        organizationId,
        clusterSize: "PS_10",
        defaultBranch,
      });

      expect(database).toMatchObject({
        defaultBranch,
      });
      await waitForDatabaseReady(
        api,
        organizationId,
        database.name,
        defaultBranch,
      );
      // Verify branch was created
      const branchResponse = await api.organizations.databases.branches.get({
        path: {
          organization: organizationId,
          database: name,
          name: defaultBranch,
        },
      });
      expect(branchResponse.parent_branch).toEqual("main");
      expect(branchResponse.cluster_name).toEqual("PS_10");

      // Update default branch on existing database
      await Database("create-branch", {
        name,
        organizationId,
        clusterSize: "PS_20",
        defaultBranch,
      });

      // Verify branch cluster size was updated
      await waitForDatabaseReady(
        api,
        organizationId,
        database.name,
        defaultBranch,
      );
      const newBranchResponse = await api.organizations.databases.branches.get({
        path: {
          organization: organizationId,
          database: name,
          name: defaultBranch,
        },
      });
      expect(newBranchResponse.cluster_name).toEqual("PS_20");
    } catch (err) {
      console.error("Test error:", err);
      throw err;
    } finally {
      await destroy(scope);

      // Verify database was deleted
      await assertDatabaseDeleted(api, organizationId, name);
    }
  }, 1000_000); //must wait on multiple resizes
});

/**
 * Wait for database to be deleted (return 404) for up to 60 seconds
 */
async function assertDatabaseDeleted(
  api: PlanetScaleClient,
  organizationId: string,
  databaseName: string,
): Promise<void> {
  const timeout = 1000_000;
  const interval = 2_000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const response = await api.organizations.databases.get({
      path: {
        organization: organizationId,
        name: databaseName,
      },
      result: "full",
    });

    console.log(
      `Waiting for database ${databaseName} to be deleted: ${response.status}`,
    );

    if (response.status === 404) {
      // Database is deleted, test passes
      return;
    }

    // Database still exists, wait and try again
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  // Timeout reached, database still exists
  throw new Error(
    `Database ${databaseName} was not deleted within ${timeout}ms`,
  );
}
