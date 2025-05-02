import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy.js";
import { PermissionGroups } from "../../src/cloudflare/permission-groups.js";
import { BRANCH_PREFIX } from "../util.js";

import "../../src/test/bun.js";

const test = alchemy.test(import.meta);

describe("PermissionGroups Resource", () => {
  const testId = `${BRANCH_PREFIX}-permission-groups`;

  test("fetch and verify well-known permission groups", async (scope) => {
    try {
      // Fetch all permission groups
      const permissionGroups = await PermissionGroups(testId);

      // Verify the resource has expected properties
      expect(permissionGroups).toBeTruthy();

      // Verify R2 related permission groups exist
      expect(permissionGroups["Workers R2 Storage Write"]).toBeTruthy();
      expect(permissionGroups["Workers R2 Storage Read"]).toBeTruthy();
      expect(
        permissionGroups["Workers R2 Storage Bucket Item Write"],
      ).toBeTruthy();
      expect(
        permissionGroups["Workers R2 Storage Bucket Item Read"],
      ).toBeTruthy();

      // Verify the structure of one of the permission groups
      const r2ReadGroup = permissionGroups["Workers R2 Storage Read"];
      expect(r2ReadGroup.id).toBeTruthy();
      expect(r2ReadGroup.name).toEqual("Workers R2 Storage Read");
      expect(Array.isArray(r2ReadGroup.scopes)).toBe(true);
      expect(r2ReadGroup.scopes.length).toBeGreaterThan(0);

      // Verify some other common permission groups
      expect(permissionGroups["Account Settings Read"]).toBeTruthy();
      expect(permissionGroups["DNS Read"]).toBeTruthy();
      expect(permissionGroups["Workers Scripts Write"]).toBeTruthy();
    } finally {
      // Clean up - this should just destroy the reference to the permission groups
      // since it's a read-only resource
      await alchemy.destroy(scope);
    }
  });
});
