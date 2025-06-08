import { afterAll, describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { createCloudflareApi } from "../../src/cloudflare/api.ts";
import { EmailAddress } from "../../src/cloudflare/email-address.ts";
import { destroy } from "../../src/destroy.ts";
import { BRANCH_PREFIX } from "../util.ts";

import type { Scope } from "../../src/scope.ts";
import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

let scope: Scope | undefined;

afterAll(async () => {
  if (scope) {
    await destroy(scope);
  }
});

describe("EmailAddress Resource", async () => {
  const api = await createCloudflareApi();

  test("create, update, and delete email address", async (scope) => {
    let emailAddress;
    const testEmail = `test-${BRANCH_PREFIX}@example.com`;

    try {
      // Create email address
      emailAddress = await EmailAddress(`${BRANCH_PREFIX}-email-addr`, {
        email: testEmail,
      });

      expect(emailAddress).toMatchObject({
        email: testEmail,
        verified: false, // New addresses start unverified
      });
      expect(emailAddress.created).toBeDefined();
      expect(emailAddress.modified).toBeDefined();
      expect(emailAddress.tag).toBeDefined();

      // Verify email address exists by querying the API directly
      const response = await api.get(
        `/accounts/${api.accountId}/email/routing/addresses/${encodeURIComponent(testEmail)}`,
      );
      expect(response.ok).toBe(true);

      const data: any = await response.json();
      expect(data.result.email).toBe(testEmail);
      expect(data.result.verified).toBe(false);

      // Update with same email (should return existing)
      emailAddress = await EmailAddress(`${BRANCH_PREFIX}-email-addr`, {
        email: testEmail,
      });

      expect(emailAddress.email).toBe(testEmail);

      // Update with different email (should delete old and create new)
      const newTestEmail = `test-new-${BRANCH_PREFIX}@example.com`;
      emailAddress = await EmailAddress(`${BRANCH_PREFIX}-email-addr`, {
        email: newTestEmail,
      });

      expect(emailAddress.email).toBe(newTestEmail);

      // Verify old email was deleted
      const oldResponse = await api.get(
        `/accounts/${api.accountId}/email/routing/addresses/${encodeURIComponent(testEmail)}`,
      );
      expect(oldResponse.status).toBe(404);

      // Verify new email exists
      const newResponse = await api.get(
        `/accounts/${api.accountId}/email/routing/addresses/${encodeURIComponent(newTestEmail)}`,
      );
      expect(newResponse.ok).toBe(true);
    } finally {
      await destroy(scope);
      if (emailAddress?.email) {
        await assertEmailAddressDoesNotExist(api, emailAddress.email);
      }
    }
  });

  test("handle existing email address", async (scope) => {
    const testEmail = `existing-${BRANCH_PREFIX}@example.com`;

    try {
      // Create email address first via API
      const createResponse = await api.post(
        `/accounts/${api.accountId}/email/routing/addresses`,
        { email: testEmail },
      );
      expect(createResponse.ok).toBe(true);

      // Now create through Alchemy - should return existing
      const emailAddress = await EmailAddress(
        `${BRANCH_PREFIX}-existing-email`,
        {
          email: testEmail,
        },
      );

      expect(emailAddress.email).toBe(testEmail);
      expect(emailAddress.verified).toBe(false);
    } finally {
      await destroy(scope);
      await assertEmailAddressDoesNotExist(api, testEmail);
    }
  });

  test("multiple email addresses", async (scope) => {
    const testEmail1 = `multi1-${BRANCH_PREFIX}@example.com`;
    const testEmail2 = `multi2-${BRANCH_PREFIX}@example.com`;

    try {
      // Create multiple email addresses
      const emailAddress1 = await EmailAddress(`${BRANCH_PREFIX}-email-1`, {
        email: testEmail1,
      });

      const emailAddress2 = await EmailAddress(`${BRANCH_PREFIX}-email-2`, {
        email: testEmail2,
      });

      expect(emailAddress1.email).toBe(testEmail1);
      expect(emailAddress2.email).toBe(testEmail2);

      // Verify both exist
      const response1 = await api.get(
        `/accounts/${api.accountId}/email/routing/addresses/${encodeURIComponent(testEmail1)}`,
      );
      const response2 = await api.get(
        `/accounts/${api.accountId}/email/routing/addresses/${encodeURIComponent(testEmail2)}`,
      );

      expect(response1.ok).toBe(true);
      expect(response2.ok).toBe(true);
    } finally {
      await destroy(scope);
      await assertEmailAddressDoesNotExist(api, testEmail1);
      await assertEmailAddressDoesNotExist(api, testEmail2);
    }
  });

  test("handle special characters in email", async (scope) => {
    const testEmail = `test+special.${BRANCH_PREFIX}@example-domain.com`;

    try {
      const emailAddress = await EmailAddress(
        `${BRANCH_PREFIX}-special-email`,
        {
          email: testEmail,
        },
      );

      expect(emailAddress.email).toBe(testEmail);

      // Verify via API with proper encoding
      const response = await api.get(
        `/accounts/${api.accountId}/email/routing/addresses/${encodeURIComponent(testEmail)}`,
      );
      expect(response.ok).toBe(true);
    } finally {
      await destroy(scope);
      await assertEmailAddressDoesNotExist(api, testEmail);
    }
  });
});

async function assertEmailAddressDoesNotExist(api: any, email: string) {
  const response = await api.get(
    `/accounts/${api.accountId}/email/routing/addresses/${encodeURIComponent(email)}`,
  );
  expect(response.status).toBe(404);
}
