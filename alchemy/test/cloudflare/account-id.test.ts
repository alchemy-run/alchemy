import { beforeAll, describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.js";
import { AccountId } from "../../src/cloudflare/account-id.js";
import { createCloudflareApi } from "../../src/cloudflare/api.js";
import { BRANCH_PREFIX } from "../util.js";

import "../../src/test/vitest.js";

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

  test("AccountId function", async () => {
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
  });
});
