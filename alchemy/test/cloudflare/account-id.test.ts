import { beforeAll, describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { AccountId } from "../../src/cloudflare/account-id.ts";
import { createCloudflareApi } from "../../src/cloudflare/api.ts";
import { BRANCH_PREFIX } from "../util.ts";

import { destroy } from "../../src/destroy.ts";
import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Cloudflare Account ID", () => {
  let expectedAccountId: string;

  // Get the expected account ID before running tests
  beforeAll(async () => {
    const api = await createCloudflareApi();
    expectedAccountId = api.accountId;
  });

  test("AccountId function", async (scope) => {
    try {
      // Get account ID with default options
      const accountId = await AccountId();

      // Verify account ID was retrieved correctly
      expect(accountId).toBeTruthy();
      expect(accountId).toEqual(expectedAccountId);

      // Verify account ID can be retrieved with explicit options
      const accountIdWithOptions = await AccountId({
        accountId: expectedAccountId,
      });

      expect(accountIdWithOptions).toEqual(expectedAccountId);
    } finally {
      await destroy(scope);
    }
  });
});
