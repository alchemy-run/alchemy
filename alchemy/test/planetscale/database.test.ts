import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { destroy } from "../../src/destroy.ts";
import {
  Database,
  PlanetScaleApi,
  waitForDatabaseReady,
} from "../../src/planetscale/database.ts";
import { BRANCH_PREFIX } from "../util.ts";
// must import this or else alchemy.test won't exist
import "../../src/test/vitest.ts";

const api = new PlanetScaleApi();

const test = alchemy.test(import.meta);

describe("Database Resource", () => {
  const organizationId = process.env.PLANETSCALE_ORG_ID || "";

  if (!organizationId) {
    throw new Error(
      "PLANETSCALE_ORG_ID environment variable is required for tests",
    );
  }

  test("create database with minimal settings", async (scope) => {
    const testId = `${BRANCH_PREFIX}-test-db-basic`;

    try {
      const database = await Database(testId, {
        name: testId,
        organizationId,
        clusterSize: "PS_10",
        defaultBranch: "main",
      });

      expect(database.id).toBeTruthy();
      expect(database.name).toEqual(testId);
      expect(database.organizationId).toEqual(organizationId);
      expect(database.state).toBeTruthy();
      expect(database.plan).toBeTruthy();
      expect(database.createdAt).toBeTruthy();
      expect(database.updatedAt).toBeTruthy();
      expect(database.htmlUrl).toBeTruthy();

      // Branch won't exist until database is ready
      await waitForDatabaseReady(api, organizationId, testId);

      // Verify main branch cluster size
      const mainBranchResponse = await api.get(
        `/organizations/${organizationId}/databases/${testId}/branches/main`,
      );

      expect(mainBranchResponse.status).toEqual(200);
      const mainBranchData = await mainBranchResponse.json<any>();
      expect(mainBranchData.cluster_name).toEqual("PS_10");
    } finally {
      await destroy(scope);
      // Verify database was deleted by checking API directly
      const getDeletedResponse = await api.get(
        `/organizations/${organizationId}/databases/${testId}`,
      );
      expect(getDeletedResponse.status).toEqual(404);
    }
  }, 600_000);

  test("create, update, and delete database", async (scope) => {
    const testId = `${BRANCH_PREFIX}-test-db-crud`;
    let database;
    try {
      // Create test database with initial settings
      database = await Database(testId, {
        name: testId,
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

      expect(database.id).toBeTruthy();
      expect(database.name).toEqual(testId);
      expect(database.organizationId).toEqual(organizationId);
      expect(database.allowDataBranching).toEqual(true);
      expect(database.automaticMigrations).toEqual(true);
      expect(database.requireApprovalForDeploy).toEqual(false);
      expect(database.restrictBranchRegion).toEqual(true);
      expect(database.insightsRawQueries).toEqual(true);
      expect(database.productionBranchWebConsole).toEqual(true);
      expect(database.defaultBranch).toEqual("main");
      expect(database.migrationFramework).toEqual("rails");
      expect(database.migrationTableName).toEqual("schema_migrations");
      expect(database.state).toBeTruthy();
      expect(database.plan).toBeTruthy();
      expect(database.createdAt).toBeTruthy();
      expect(database.updatedAt).toBeTruthy();
      expect(database.htmlUrl).toBeTruthy();

      // Update database settings
      database = await Database(testId, {
        name: testId,
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

      expect(database.allowDataBranching).toEqual(false);
      expect(database.automaticMigrations).toEqual(false);
      expect(database.requireApprovalForDeploy).toEqual(true);
      expect(database.restrictBranchRegion).toEqual(false);
      expect(database.insightsRawQueries).toEqual(false);
      expect(database.productionBranchWebConsole).toEqual(false);
      expect(database.defaultBranch).toEqual("main");
      expect(database.migrationFramework).toEqual("django");
      expect(database.migrationTableName).toEqual("django_migrations");

      // Verify main branch cluster size was updated
      const mainBranchResponse = await api.get(
        `/organizations/${organizationId}/databases/${testId}/branches/main`,
      );
      expect(mainBranchResponse.status).toEqual(200);
      const mainBranchData = await mainBranchResponse.json<any>();
      expect(mainBranchData.cluster_rate_name).toEqual("PS_20");
    } catch (err) {
      console.error("Test error:", err);
      throw err;
    } finally {
      // Cleanup
      await destroy(scope);

      // Verify database was deleted by checking API directly
      const getDeletedResponse = await api.get(
        `/organizations/${organizationId}/databases/${testId}`,
      );
      expect(getDeletedResponse.status).toEqual(404);
    }
  }, 600_000); // this test takes forever as it needs to wait on multiple resizes!

  test("creates non-main default branch if specified", async (scope) => {
    const testId = `${BRANCH_PREFIX}-test-db-default-branch`;
    try {
      // Create database with custom default branch
      const customBranch = `${testId}-branch`;
      const database = await Database(testId, {
        name: testId,
        organizationId,
        clusterSize: "PS_10",
        defaultBranch: customBranch,
      });

      expect(database.defaultBranch).toEqual(customBranch);
      await waitForDatabaseReady(
        api,
        organizationId,
        database.name,
        customBranch,
      );
      // Verify branch was created
      const branchResponse = await api.get(
        `/organizations/${organizationId}/databases/${testId}/branches/${customBranch}`,
      );
      expect(branchResponse.status).toEqual(200);

      const branchData = await branchResponse.json<any>();
      expect(branchData.parent_branch).toEqual("main");
      expect(branchData.cluster_rate_name).toEqual("PS_10");

      // Update default branch on existing database
      await Database(testId, {
        name: testId,
        organizationId,
        clusterSize: "PS_20",
        defaultBranch: customBranch,
      });

      // Verify branch cluster size was updated
      await waitForDatabaseReady(
        api,
        organizationId,
        database.name,
        customBranch,
      );
      const newBranchResponse = await api.get(
        `/organizations/${organizationId}/databases/${testId}/branches/${customBranch}`,
      );
      expect(newBranchResponse.status).toEqual(200);

      const newBranchData = await newBranchResponse.json<any>();
      expect(newBranchData.cluster_rate_name).toEqual("PS_20");
    } catch (err) {
      console.error("Test error:", err);
      throw err;
    } finally {
      await destroy(scope);

      // Verify database was deleted
      const getDeletedResponse = await api.get(
        `/organizations/${organizationId}/databases/${testId}`,
      );
      expect(getDeletedResponse.status).toEqual(404);
    }
  }, 1000_000); //must wait on multiple resizes
});
