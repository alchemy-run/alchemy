import { afterAll, describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { destroy } from "../../src/destroy.ts";
import { PlanetScaleClient } from "../../src/planetscale/api/client.gen.ts";
import { Branch } from "../../src/planetscale/branch.ts";
import { Database } from "../../src/planetscale/database.ts";
import { Password } from "../../src/planetscale/password.ts";
import { waitForDatabaseReady } from "../../src/planetscale/utils.ts";
import { BRANCH_PREFIX } from "../util.ts";
// must import this or else alchemy.test won't exist
import type { Scope } from "../../src/scope.ts";
import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe.skipIf(!process.env.PLANETSCALE_TEST)("Password Resource", () => {
  const api = new PlanetScaleClient();
  const organizationId = alchemy.env.PLANETSCALE_ORG_ID;

  let database: Database;
  let branch: Branch;
  let scope: Scope | undefined;

  test.beforeAll(async (_scope) => {
    database = await Database("password-test-db", {
      organizationId,
      clusterSize: "PS_10",
    });
    await waitForDatabaseReady(api, organizationId, database.name);

    branch = await Branch("password-test-branch", {
      organizationId,
      databaseName: database.name,
      parentBranch: "main",
      isProduction: false,
    });

    scope = _scope;
  });

  afterAll(async () => {
    if (scope) {
      await destroy(scope);
    }
  });

  test("create, update, and delete password", async (scope) => {
    const name = `${BRANCH_PREFIX}-test-password`;

    try {
      // Create a password
      let password = await Password(name, {
        name,
        organizationId,
        database: database.name,
        branch: branch.name,
        role: "reader",
      });

      expect(password.id).toBeTruthy();
      expect(password.name).toEqual(`${name}-${password.nameSlug}`);
      expect(password.role).toEqual("reader");
      expect(password.host).toBeTruthy();
      expect(password.username).toBeTruthy();
      expect(password.password).toBeTruthy();

      // Verify password was created by querying the API directly
      const getResponse =
        await api.organizations.databases.branches.passwords.get({
          path: {
            organization: organizationId,
            database: database.name,
            branch: branch.name,
            id: password.id,
          },
        });
      expect(getResponse.name).toEqual(`${name}-${password.nameSlug}`);
      expect(getResponse.role).toEqual("reader");

      // Update the password (only name and cidrs should trigger update, not replace)
      password = await Password(name, {
        name: `${name}-updated`,
        organizationId,
        database: database.name,
        branch: branch.name,
        role: "reader",
      });

      expect(password.name).toEqual(`${name}-updated-${password.nameSlug}`);

      // Verify password was updated
      const getUpdatedResponse =
        await api.organizations.databases.branches.passwords.get({
          path: {
            organization: organizationId,
            database: database.name,
            branch: branch.name,
            id: password.id,
          },
        });

      expect(getUpdatedResponse.name).toEqual(
        `${name}-updated-${password.nameSlug}`,
      );
    } finally {
      await destroy(scope);
    }
  });

  test("password gets replaced when properties other than name and cidrs change", async (scope) => {
    const name = `${BRANCH_PREFIX}-test-password-replace`;

    try {
      // Create initial password
      let password = await Password(name, {
        name,
        organizationId,
        database: database.name,
        branch: branch.name,
        role: "reader",
        ttl: 3600,
        cidrs: ["0.0.0.0/0"],
      });

      const originalId = password.id;
      expect(password.role).toEqual("reader");
      expect(password.ttl).toEqual(3600);

      // Update password with different role (should trigger replacement)
      password = await Password(name, {
        name,
        organizationId,
        database: database.name,
        branch: branch.name,
        role: "writer", // Changed role
        ttl: 3600,
        cidrs: ["0.0.0.0/0"],
      });

      // Should have a new ID due to replacement
      expect(password.id).not.toEqual(originalId);
      expect(password.role).toEqual("writer");

      // Destroy pending deletions to verify replacement
      await scope.destroyPendingDeletions();

      // Verify old password was deleted and new one created
      const getOldResponse =
        await api.organizations.databases.branches.passwords.get({
          path: {
            organization: organizationId,
            database: database.name,
            branch: branch.name,
            id: originalId,
          },
          result: "full",
        });
      expect(getOldResponse.status).toEqual(404);

      const getNewResponse =
        await api.organizations.databases.branches.passwords.get({
          path: {
            organization: organizationId,
            database: database.name,
            branch: branch.name,
            id: password.id,
          },
        });
      expect(getNewResponse.role).toEqual("writer");
    } finally {
      await destroy(scope);
    }
  });
});
