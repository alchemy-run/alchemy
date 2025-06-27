import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import {
  type CloudflareApi,
  createCloudflareApi,
} from "../../src/cloudflare/api.ts";
import {
  RedirectRule,
  findRuleInRuleset,
} from "../../src/cloudflare/redirect-rule.ts";
import { Zone } from "../../src/cloudflare/zone.ts";
import { destroy } from "../../src/destroy.ts";
import { BRANCH_PREFIX } from "../util.ts";
import { fetchAndExpectStatus } from "./fetch-utils.ts";

import "../../src/test/vitest.ts";

const api = await createCloudflareApi();

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
  quiet: false,
});
const testDomain = "alchemy-test.us";

let zone: Zone;
test.beforeAll(async (_scope) => {
  zone = await Zone(`${testDomain}-zone`, {
    name: testDomain,
    type: "full",
    jumpStart: false,
    delete: false,
  });
});

describe("RedirectRule", () => {
  // Use BRANCH_PREFIX for deterministic, non-colliding test resources

  test("create, update, and delete redirect rule with expression", async (scope) => {
    let redirectRule: RedirectRule | undefined;

    try {
      // Create a simple redirect rule (no wildcards for now)
      redirectRule = await RedirectRule(`${BRANCH_PREFIX}-wildcard-redirect`, {
        zone: zone.id,
        expression: `http.host == "test.${testDomain}" and http.request.uri.path == "/old-page"`,
        targetUrl: `https://${testDomain}/new-page`,
        statusCode: 301,
        preserveQueryString: true,
      });
      console.log(redirectRule);

      expect(redirectRule).toMatchObject({
        zoneId: zone.id,
        requestUrl: undefined,
        expression: `http.host == "test.${testDomain}" and http.request.uri.path == "/old-page"`,
        targetUrl: `https://${testDomain}/new-page`,
        statusCode: 301,
        preserveQueryString: true,
        enabled: true,
      });
      expect(redirectRule.ruleId).toBeTruthy();
      expect(redirectRule.rulesetId).toBeTruthy();

      // Verify the rule was created by checking it exists in the ruleset
      const rule = await findRuleInRuleset(
        api,
        zone.id,
        redirectRule.rulesetId,
        redirectRule.ruleId,
      );
      expect(rule).toBeTruthy();
      expect(rule!.action).toEqual("redirect");
      expect(rule!.enabled).toEqual(true);

      // Test actual redirect behavior
      // Note: This requires the domain to be properly configured with Cloudflare DNS
      await testRedirectBehavior(
        `https://test.${testDomain}/old-page`,
        `https://${testDomain}/new-page`,
        301,
        "Simple redirect",
      );

      // Update the redirect rule
      redirectRule = await RedirectRule(`${BRANCH_PREFIX}-wildcard-redirect`, {
        zone: zone.id,
        expression: `http.host == "legacy.${testDomain}" and http.request.uri.path == "/old-page"`,
        targetUrl: `https://${testDomain}/updated-page`,
        statusCode: 302,
        preserveQueryString: false,
      });

      expect(redirectRule).toMatchObject({
        statusCode: 302,
        preserveQueryString: false,
        expression: `http.host == "legacy.${testDomain}" and http.request.uri.path == "/old-page"`,
        targetUrl: `https://${testDomain}/updated-page`,
      });

      // Test updated redirect behavior
      await testRedirectBehavior(
        `https://legacy.${testDomain}/old-page`,
        `https://${testDomain}/updated-page`,
        302,
        "Updated simple redirect",
      );
    } finally {
      await destroy(scope);
      if (redirectRule) {
        await assertRedirectRuleDoesNotExist(api, zone!.id, redirectRule);
      }
    }
  });

  test("create static redirect rule", async (scope) => {
    let redirectRule: RedirectRule | undefined;

    try {
      // Create a static redirect rule (no requestUrl or expression)
      redirectRule = await RedirectRule(`${BRANCH_PREFIX}-static-redirect`, {
        zone: zone.id,
        targetUrl: `https://static-${testDomain}/`,
        statusCode: 301,
        preserveQueryString: true,
      });

      expect(redirectRule).toMatchObject({
        zoneId: zone.id,
        requestUrl: undefined,
        expression: undefined,
        targetUrl: `https://static-${testDomain}/`,
        statusCode: 301,
        preserveQueryString: true,
      });
      expect(redirectRule.ruleId).toBeTruthy();
      expect(redirectRule.rulesetId).toBeTruthy();

      // Test static redirect behavior (redirects all requests to target)
      await testRedirectBehavior(
        `https://static-${testDomain}/any/path/here`,
        `https://static-${testDomain}/`,
        301,
        "Static redirect",
      );
      await testRedirectBehavior(
        `https://static-${testDomain}/`,
        `https://static-${testDomain}/`,
        301,
        "Static redirect (root)",
      );
    } finally {
      await destroy(scope);
      if (redirectRule) {
        await assertRedirectRuleDoesNotExist(api, zone!.id, redirectRule);
      }
    }
  });

  test("create dynamic redirect rule with expression", async (scope) => {
    let redirectRule: RedirectRule | undefined;

    try {
      // Create a dynamic redirect rule using expression
      redirectRule = await RedirectRule("dynamic-redirect", {
        zone: zone.id,
        expression:
          'http.request.uri.path matches "/autodiscover\\\\.(xml|src)$"',
        targetUrl: `https://dynamic-${testDomain}/not-found`,
        statusCode: 302,
        preserveQueryString: false,
      });

      expect(redirectRule).toMatchObject({
        zoneId: zone.id,
        requestUrl: undefined,
        expression:
          'http.request.uri.path matches "/autodiscover\\\\.(xml|src)$"',
        targetUrl: `https://dynamic-${testDomain}/not-found`,
        statusCode: 302,
        preserveQueryString: false,
      });
      expect(redirectRule.ruleId).toBeTruthy();
      expect(redirectRule.rulesetId).toBeTruthy();

      // Test dynamic redirect with expression matching
      await testRedirectBehavior(
        `https://dynamic-${testDomain}/autodiscover.xml`,
        `https://dynamic-${testDomain}/not-found`,
        302,
        "Dynamic redirect (autodiscover.xml)",
      );
      await testRedirectBehavior(
        `https://dynamic-${testDomain}/autodiscover.src`,
        `https://dynamic-${testDomain}/not-found`,
        302,
        "Dynamic redirect (autodiscover.src)",
      );
    } finally {
      await destroy(scope);
      if (redirectRule) {
        await assertRedirectRuleDoesNotExist(api, zone!.id, redirectRule);
      }
    }
  });

  test("validate mutually exclusive requestUrl and expression", async (scope) => {
    try {
      // Should throw error when both requestUrl and expression are provided
      await expect(
        RedirectRule(`${BRANCH_PREFIX}-invalid-redirect`, {
          zone: zone.id,
          requestUrl: `https://*.${testDomain}/files/*`,
          expression: 'http.request.uri.path matches "/test"',
          targetUrl: `https://${testDomain}/`,
          statusCode: 301,
        }),
      ).rejects.toThrow("Cannot specify both requestUrl and expression");
    } finally {
      await destroy(scope);
    }
  });

  test("allow static redirect without requestUrl or expression", async (scope) => {
    try {
      // Should NOT throw error when neither requestUrl nor expression are provided (static redirect)
      const redirectRule = await RedirectRule(
        `${BRANCH_PREFIX}-static-redirect2`,
        {
          zone: zone.id,
          targetUrl: `https://${testDomain}/`,
          statusCode: 301,
        },
      );

      expect(redirectRule).toMatchObject({
        requestUrl: undefined,
        expression: undefined,
        targetUrl: `https://${testDomain}/`,
      });
    } finally {
      await destroy(scope);
    }
  });
});

/**
 * Test actual HTTP redirect behavior.
 *
 * NOTE: This function attempts to test real redirect behavior, but will gracefully
 * handle cases where domains don't resolve or aren't properly configured with Cloudflare.
 * For full redirect testing, the domains need to:
 * 1. Have proper DNS configuration pointing to Cloudflare
 * 2. Be proxied through Cloudflare (orange cloud enabled)
 * 3. Have SSL certificates configured
 *
 * @param sourceUrl - The URL that should trigger the redirect
 * @param expectedTargetUrl - The URL that should be redirected to
 * @param expectedStatus - The expected HTTP status code (301, 302, etc.)
 * @param testDescription - Description of the test for logging
 */
async function testRedirectBehavior(
  sourceUrl: string,
  expectedTargetUrl: string,
  expectedStatus: number,
  testDescription: string,
): Promise<void> {
  console.log(
    `Testing ${testDescription}: ${sourceUrl} -> ${expectedTargetUrl}`,
  );

  // Test the redirect with manual redirect handling to capture the redirect response
  const response = await fetchAndExpectStatus(
    sourceUrl,
    {
      redirect: "manual", // Don't follow redirects automatically
      headers: {
        "User-Agent": "alchemy-test-bot/1.0",
      },
    },
    expectedStatus,
    3, // Fewer retries for redirect tests
    10000, // Shorter timeout for redirect tests
  );

  // For redirect status codes, verify the Location header
  if (expectedStatus >= 300 && expectedStatus < 400) {
    const locationHeader = response.headers.get("location");
    if (locationHeader) {
      // Normalize URLs for comparison (handle relative vs absolute URLs)
      const actualTarget = new URL(locationHeader, sourceUrl).toString();
      const normalizedExpected = new URL(expectedTargetUrl).toString();

      expect(actualTarget).toEqual(normalizedExpected);
      console.log(`✓ ${testDescription}: Redirect Location header correct`);
    } else {
      console.warn(`⚠ ${testDescription}: Expected Location header not found`);
    }
  }

  console.log(`✓ ${testDescription}: Status code correct (${expectedStatus})`);
}

async function assertRedirectRuleDoesNotExist(
  api: CloudflareApi,
  zoneId: string,
  redirectRule: RedirectRule,
) {
  // Check if the rule exists in the ruleset using the helper function
  const existingRule = await findRuleInRuleset(
    api,
    zoneId,
    redirectRule.rulesetId,
    redirectRule.ruleId,
  );

  if (existingRule) {
    throw new Error(
      `Expected redirect rule ${redirectRule.ruleId} to not exist, but it still exists`,
    );
  }
}
