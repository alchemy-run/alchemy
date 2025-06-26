import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { createCloudflareApi } from "../../src/cloudflare/api.ts";
import { RedirectRule } from "../../src/cloudflare/redirect-rule.ts";
import { Zone } from "../../src/cloudflare/zone.ts";
import { destroy } from "../../src/destroy.ts";
import { BRANCH_PREFIX } from "../util.ts";

import "../../src/test/vitest.ts";

const api = await createCloudflareApi();

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("RedirectRule", () => {
  // Use BRANCH_PREFIX for deterministic, non-colliding test resources
  const testDomain = `${BRANCH_PREFIX}-redirect-test.dev`;

  test("create, update, and delete wildcard redirect rule", async (scope) => {
    let zone: Zone | undefined;
    let redirectRule: RedirectRule | undefined;

    try {
      // Create a test zone first
      zone = await Zone(`${testDomain}-zone`, {
        name: testDomain,
        type: "full",
        jumpStart: false,
      });

      // Create a wildcard redirect rule
      redirectRule = await RedirectRule(`${BRANCH_PREFIX}-wildcard-redirect`, {
        zone: zone.id,
        requestUrl: `https://*.${testDomain}/files/*`,
        targetUrl: `https://${testDomain}/\${1}/files/\${2}`,
        statusCode: 301,
        preserveQueryString: true,
      });

      expect(redirectRule.ruleId).toBeTruthy();
      expect(redirectRule.rulesetId).toBeTruthy();
      expect(redirectRule.zoneId).toEqual(zone.id);
      expect(redirectRule.requestUrl).toEqual(
        `https://*.${testDomain}/files/*`,
      );
      expect(redirectRule.targetUrl).toEqual(
        `https://${testDomain}/\${1}/files/\${2}`,
      );
      expect(redirectRule.statusCode).toEqual(301);
      expect(redirectRule.preserveQueryString).toEqual(true);
      expect(redirectRule.enabled).toEqual(true);

      // Verify the rule was created by querying the API directly
      const getRuleResponse = await api.get(
        `/zones/${zone.id}/rulesets/${redirectRule.rulesetId}/rules/${redirectRule.ruleId}`,
      );
      expect(getRuleResponse.status).toEqual(200);

      const ruleData: any = await getRuleResponse.json();
      expect(ruleData.result.action).toEqual("redirect");
      expect(ruleData.result.enabled).toEqual(true);

      // Update the redirect rule
      redirectRule = await RedirectRule(`${BRANCH_PREFIX}-wildcard-redirect`, {
        zone: zone.id,
        requestUrl: `https://*.${testDomain}/old/*`,
        targetUrl: `https://${testDomain}/new/\${1}/\${2}`,
        statusCode: 302,
        preserveQueryString: false,
      });

      expect(redirectRule.statusCode).toEqual(302);
      expect(redirectRule.preserveQueryString).toEqual(false);
      expect(redirectRule.requestUrl).toEqual(`https://*.${testDomain}/old/*`);
      expect(redirectRule.targetUrl).toEqual(
        `https://${testDomain}/new/\${1}/\${2}`,
      );
    } finally {
      await destroy(scope);
      if (redirectRule) {
        await assertRedirectRuleDoesNotExist(api, zone!.id, redirectRule);
      }
    }
  });

  test("create static redirect rule", async (scope) => {
    let zone: Zone | undefined;
    let redirectRule: RedirectRule | undefined;

    try {
      // Create a test zone first
      zone = await Zone(`${testDomain}-static-zone`, {
        name: `static-${testDomain}`,
        type: "full",
        jumpStart: false,
      });

      // Create a static redirect rule (no requestUrl or expression)
      redirectRule = await RedirectRule(`${BRANCH_PREFIX}-static-redirect`, {
        zone: zone.id,
        targetUrl: `https://static-${testDomain}/`,
        statusCode: 301,
        preserveQueryString: true,
      });

      expect(redirectRule.ruleId).toBeTruthy();
      expect(redirectRule.rulesetId).toBeTruthy();
      expect(redirectRule.zoneId).toEqual(zone.id);
      expect(redirectRule.requestUrl).toBeUndefined();
      expect(redirectRule.expression).toBeUndefined();
      expect(redirectRule.targetUrl).toEqual(`https://static-${testDomain}/`);
      expect(redirectRule.statusCode).toEqual(301);
      expect(redirectRule.preserveQueryString).toEqual(true);
    } finally {
      await destroy(scope);
      if (redirectRule) {
        await assertRedirectRuleDoesNotExist(api, zone!.id, redirectRule);
      }
    }
  });

  test("create dynamic redirect rule with expression", async (scope) => {
    let zone: Zone | undefined;
    let redirectRule: RedirectRule | undefined;

    try {
      // Create a test zone first
      zone = await Zone(`${testDomain}-dynamic-zone`, {
        name: `dynamic-${testDomain}`,
        type: "full",
        jumpStart: false,
      });

      // Create a dynamic redirect rule using expression
      redirectRule = await RedirectRule(`${BRANCH_PREFIX}-dynamic-redirect`, {
        zone: zone.id,
        expression:
          'http.request.uri.path matches "/autodiscover\\\\.(xml|src)$"',
        targetUrl: `https://dynamic-${testDomain}/not-found`,
        statusCode: 404,
        preserveQueryString: false,
      });

      expect(redirectRule.ruleId).toBeTruthy();
      expect(redirectRule.rulesetId).toBeTruthy();
      expect(redirectRule.zoneId).toEqual(zone.id);
      expect(redirectRule.requestUrl).toBeUndefined();
      expect(redirectRule.expression).toEqual(
        'http.request.uri.path matches "/autodiscover\\\\.(xml|src)$"',
      );
      expect(redirectRule.targetUrl).toEqual(
        `https://dynamic-${testDomain}/not-found`,
      );
      expect(redirectRule.statusCode).toEqual(404);
      expect(redirectRule.preserveQueryString).toEqual(false);
    } finally {
      await destroy(scope);
      if (redirectRule) {
        await assertRedirectRuleDoesNotExist(api, zone!.id, redirectRule);
      }
    }
  });

  test("validate mutually exclusive requestUrl and expression", async (scope) => {
    let zone: Zone | undefined;

    try {
      // Create a test zone first
      zone = await Zone(`${testDomain}-validation-zone`, {
        name: `validation-${testDomain}`,
        type: "full",
        jumpStart: false,
      });

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
    let zone: Zone | undefined;

    try {
      // Create a test zone first
      zone = await Zone(`${testDomain}-validation2-zone`, {
        name: `validation2-${testDomain}`,
        type: "full",
        jumpStart: false,
      });

      // Should NOT throw error when neither requestUrl nor expression are provided (static redirect)
      const redirectRule = await RedirectRule(`${BRANCH_PREFIX}-static-redirect2`, {
        zone: zone.id,
        targetUrl: `https://${testDomain}/`,
        statusCode: 301,
      });

      expect(redirectRule.requestUrl).toBeUndefined();
      expect(redirectRule.expression).toBeUndefined();
      expect(redirectRule.targetUrl).toEqual(`https://${testDomain}/`);
    } finally {
      await destroy(scope);
    }
  });
});

async function assertRedirectRuleDoesNotExist(
  api: typeof import("../../src/cloudflare/api.ts").CloudflareApi.prototype,
  zoneId: string,
  redirectRule: RedirectRule,
) {
  const response = await api.get(
    `/zones/${zoneId}/rulesets/${redirectRule.rulesetId}/rules/${redirectRule.ruleId}`,
  );
  if (response.status !== 404) {
    throw new Error(
      `Expected redirect rule ${redirectRule.ruleId} to not exist, but it still exists`,
    );
  }
}
