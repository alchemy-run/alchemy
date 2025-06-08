import { afterAll, describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { createCloudflareApi } from "../../src/cloudflare/api.ts";
import { EmailAddress } from "../../src/cloudflare/email-address.ts";
import { EmailRouting } from "../../src/cloudflare/email-routing.ts";
import { EmailRule } from "../../src/cloudflare/email-rule.ts";
import { Zone } from "../../src/cloudflare/zone.ts";
import { destroy } from "../../src/destroy.ts";
import { BRANCH_PREFIX } from "../util.ts";

import type { Scope } from "../../src/scope.ts";
import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const testDomain = `${BRANCH_PREFIX}-rule-test.com`;

let zone: Zone;
let _emailRouting: EmailRouting;
let destinationEmail: EmailAddress;
let scope: Scope | undefined;

test.beforeAll(async (_scope) => {
  zone = await Zone(`${BRANCH_PREFIX}-rule-zone`, {
    name: testDomain,
  });

  // Enable email routing for the zone
  _emailRouting = await EmailRouting(`${BRANCH_PREFIX}-rule-routing`, {
    zone: zone.id,
    enabled: true,
    skipWizard: true,
  });

  // Create a destination email address
  destinationEmail = await EmailAddress(`${BRANCH_PREFIX}-rule-email`, {
    email: `admin-${BRANCH_PREFIX}@example.com`,
  });

  scope = _scope;
});

afterAll(async () => {
  if (scope) {
    await destroy(scope);
  }
});

describe("EmailRule Resource", async () => {
  const api = await createCloudflareApi();

  test("create, update, and delete email rule", async (scope) => {
    let emailRule;

    try {
      // Create email rule with forward action
      emailRule = await EmailRule(`${BRANCH_PREFIX}-email-rule`, {
        zone: zone.id,
        name: "Test forwarding rule",
        enabled: true,
        priority: 1,
        matchers: [
          {
            type: "literal",
            field: "to",
            value: `info@${testDomain}`,
          },
        ],
        actions: [
          {
            type: "forward",
            value: [destinationEmail.email],
          },
        ],
      });

      expect(emailRule).toMatchObject({
        zoneId: zone.id,
        name: "Test forwarding rule",
        enabled: true,
        priority: 1,
        matchers: [
          {
            type: "literal",
            field: "to",
            value: `info@${testDomain}`,
          },
        ],
        actions: [
          {
            type: "forward",
            value: [destinationEmail.email],
          },
        ],
      });
      expect(emailRule.ruleId).toBeDefined();
      expect(emailRule.tag).toBeDefined();

      // Verify rule exists by querying the API directly
      const response = await api.get(
        `/zones/${zone.id}/email/routing/rules/${emailRule.ruleId}`,
      );
      expect(response.ok).toBe(true);

      const data: any = await response.json();
      expect(data.result.name).toBe("Test forwarding rule");
      expect(data.result.enabled).toBe(true);
      expect(data.result.priority).toBe(1);

      // Update rule - change name and add another action
      emailRule = await EmailRule(`${BRANCH_PREFIX}-email-rule`, {
        zone: zone.id,
        name: "Updated forwarding rule",
        enabled: true,
        priority: 2,
        matchers: [
          {
            type: "literal",
            field: "to",
            value: `support@${testDomain}`,
          },
        ],
        actions: [
          {
            type: "forward",
            value: [
              destinationEmail.email,
              `backup-${BRANCH_PREFIX}@example.com`,
            ],
          },
        ],
      });

      expect(emailRule.name).toBe("Updated forwarding rule");
      expect(emailRule.priority).toBe(2);
      expect(emailRule.matchers[0].value).toBe(`support@${testDomain}`);
      expect(emailRule.actions[0].value).toHaveLength(2);

      // Verify update via API
      const updatedResponse = await api.get(
        `/zones/${zone.id}/email/routing/rules/${emailRule.ruleId}`,
      );
      expect(updatedResponse.ok).toBe(true);

      const updatedData: any = await updatedResponse.json();
      expect(updatedData.result.name).toBe("Updated forwarding rule");
      expect(updatedData.result.priority).toBe(2);
    } finally {
      await destroy(scope);
      if (emailRule?.ruleId) {
        await assertEmailRuleDoesNotExist(api, zone.id, emailRule.ruleId);
      }
    }
  });

  test("create rule with Zone resource reference", async (scope) => {
    try {
      const emailRule = await EmailRule(`${BRANCH_PREFIX}-rule-zone-ref`, {
        zone: zone, // Use Zone resource instead of string ID
        name: "Zone reference rule",
        matchers: [
          {
            type: "literal",
            field: "to",
            value: `contact@${testDomain}`,
          },
        ],
        actions: [
          {
            type: "forward",
            value: [destinationEmail.email],
          },
        ],
      });

      expect(emailRule.zoneId).toBe(zone.id);
      expect(emailRule.name).toBe("Zone reference rule");
    } finally {
      await destroy(scope);
    }
  });

  test("create rule with worker action", async (scope) => {
    try {
      const emailRule = await EmailRule(`${BRANCH_PREFIX}-worker-rule`, {
        zone: zone.id,
        name: "Worker processing rule",
        priority: 0, // High priority
        matchers: [
          {
            type: "literal",
            field: "to",
            value: `webhook@${testDomain}`,
          },
        ],
        actions: [
          {
            type: "worker",
            value: ["email-processor"],
          },
        ],
      });

      expect(emailRule.actions[0].type).toBe("worker");
      expect(emailRule.actions[0].value).toEqual(["email-processor"]);
      expect(emailRule.priority).toBe(0);
    } finally {
      await destroy(scope);
    }
  });

  test("create rule with drop action", async (scope) => {
    try {
      const emailRule = await EmailRule(`${BRANCH_PREFIX}-drop-rule`, {
        zone: zone.id,
        name: "Drop spam rule",
        matchers: [
          {
            type: "literal",
            field: "subject",
            value: "SPAM",
          },
        ],
        actions: [
          {
            type: "drop",
          },
        ],
      });

      expect(emailRule.actions[0].type).toBe("drop");
      expect(emailRule.actions[0].value).toBeUndefined();
    } finally {
      await destroy(scope);
    }
  });

  test("create rule with all matcher", async (scope) => {
    try {
      const emailRule = await EmailRule(`${BRANCH_PREFIX}-all-rule`, {
        zone: zone.id,
        name: "Catch all rule",
        priority: 999, // Low priority
        matchers: [
          {
            type: "all",
          },
        ],
        actions: [
          {
            type: "forward",
            value: [destinationEmail.email],
          },
        ],
      });

      expect(emailRule.matchers[0].type).toBe("all");
      expect(emailRule.matchers[0].field).toBeUndefined();
      expect(emailRule.matchers[0].value).toBeUndefined();
      expect(emailRule.priority).toBe(999);
    } finally {
      await destroy(scope);
    }
  });

  test("default values", async (scope) => {
    try {
      const emailRule = await EmailRule(`${BRANCH_PREFIX}-default-rule`, {
        zone: zone.id,
        // name not specified, should get default
        // enabled not specified, should default to true
        // priority not specified, should default to 0
        matchers: [
          {
            type: "literal",
            field: "to",
            value: `default@${testDomain}`,
          },
        ],
        actions: [
          {
            type: "forward",
            value: [destinationEmail.email],
          },
        ],
      });

      expect(emailRule.name).toBe("Email routing rule");
      expect(emailRule.enabled).toBe(true);
      expect(emailRule.priority).toBe(0);
    } finally {
      await destroy(scope);
    }
  });

  test("multiple matchers and actions", async (scope) => {
    try {
      const emailRule = await EmailRule(`${BRANCH_PREFIX}-multi-rule`, {
        zone: zone.id,
        name: "Complex rule",
        matchers: [
          {
            type: "literal",
            field: "to",
            value: `sales@${testDomain}`,
          },
          {
            type: "literal",
            field: "from",
            value: "important@partner.com",
          },
        ],
        actions: [
          {
            type: "forward",
            value: [destinationEmail.email],
          },
          {
            type: "worker",
            value: ["log-important-emails"],
          },
        ],
      });

      expect(emailRule.matchers).toHaveLength(2);
      expect(emailRule.actions).toHaveLength(2);
      expect(emailRule.matchers[1].field).toBe("from");
      expect(emailRule.actions[1].type).toBe("worker");
    } finally {
      await destroy(scope);
    }
  });
});

async function assertEmailRuleDoesNotExist(
  api: any,
  zoneId: string,
  ruleId: string,
) {
  const response = await api.get(
    `/zones/${zoneId}/email/routing/rules/${ruleId}`,
  );
  expect(response.status).toBe(404);
}
