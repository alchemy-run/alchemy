import { afterAll, describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { createCloudflareApi } from "../../src/cloudflare/api.ts";
import { EmailAddress } from "../../src/cloudflare/email-address.ts";
import { EmailCatchAll } from "../../src/cloudflare/email-catch-all.ts";
import { EmailRouting } from "../../src/cloudflare/email-routing.ts";
import { Zone } from "../../src/cloudflare/zone.ts";
import { destroy } from "../../src/destroy.ts";
import { BRANCH_PREFIX } from "../util.ts";

import type { Scope } from "../../src/scope.ts";
import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const testDomain = `${BRANCH_PREFIX}-catchall-test.com`;

let zone: Zone;
let emailRouting: EmailRouting;
let destinationEmail: EmailAddress;
let scope: Scope | undefined;

test.beforeAll(async (_scope) => {
  zone = await Zone(`${BRANCH_PREFIX}-catchall-zone`, {
    name: testDomain,
  });

  // Enable email routing for the zone
  emailRouting = await EmailRouting(`${BRANCH_PREFIX}-catchall-routing`, {
    zone: zone.id,
    enabled: true,
    skipWizard: true,
  });

  // Create a destination email address
  destinationEmail = await EmailAddress(`${BRANCH_PREFIX}-catchall-email`, {
    email: `catchall-${BRANCH_PREFIX}@example.com`,
  });

  scope = _scope;
});

afterAll(async () => {
  if (scope) {
    await destroy(scope);
  }
});

describe("EmailCatchAll Resource", async () => {
  const api = await createCloudflareApi();

  test("create, update, and delete catch-all rule", async (scope) => {
    let emailCatchAll;
    
    try {
      // Create catch-all rule with forward action
      emailCatchAll = await EmailCatchAll(`${BRANCH_PREFIX}-catch-all`, {
        zone: zone.id,
        enabled: true,
        name: "Forward all emails",
        actions: [
          {
            type: "forward",
            value: [destinationEmail.email],
          },
        ],
      });

      expect(emailCatchAll).toMatchObject({
        zoneId: zone.id,
        enabled: true,
        name: "Forward all emails",
        matchers: [{ type: "all" }],
        actions: [
          {
            type: "forward",
            value: [destinationEmail.email],
          },
        ],
      });
      expect(emailCatchAll.tag).toBeDefined();

      // Verify catch-all rule exists by querying the API directly
      const response = await api.get(
        `/zones/${zone.id}/email/routing/rules/catch_all`
      );
      expect(response.ok).toBe(true);

      const data: any = await response.json();
      expect(data.result.enabled).toBe(true);
      expect(data.result.name).toBe("Forward all emails");
      expect(data.result.matchers[0].type).toBe("all");

      // Update catch-all rule - change to drop action
      emailCatchAll = await EmailCatchAll(`${BRANCH_PREFIX}-catch-all`, {
        zone: zone.id,
        enabled: true,
        name: "Drop all emails",
        actions: [
          {
            type: "drop",
          },
        ],
      });

      expect(emailCatchAll.name).toBe("Drop all emails");
      expect(emailCatchAll.actions[0].type).toBe("drop");

      // Verify update via API
      const updatedResponse = await api.get(
        `/zones/${zone.id}/email/routing/rules/catch_all`
      );
      expect(updatedResponse.ok).toBe(true);

      const updatedData: any = await updatedResponse.json();
      expect(updatedData.result.name).toBe("Drop all emails");
      expect(updatedData.result.actions[0].type).toBe("drop");

      // Update to disable the catch-all rule
      emailCatchAll = await EmailCatchAll(`${BRANCH_PREFIX}-catch-all`, {
        zone: zone.id,
        enabled: false,
        actions: [
          {
            type: "drop",
          },
        ],
      });

      expect(emailCatchAll.enabled).toBe(false);
    } finally {
      await destroy(scope);
      await assertEmailCatchAllIsDisabled(api, zone.id);
    }
  });

  test("create catch-all with Zone resource reference", async (scope) => {
    try {
      const emailCatchAll = await EmailCatchAll(`${BRANCH_PREFIX}-catchall-zone-ref`, {
        zone: zone, // Use Zone resource instead of string ID
        enabled: true,
        actions: [
          {
            type: "forward",
            value: [destinationEmail.email],
          },
        ],
      });

      expect(emailCatchAll.zoneId).toBe(zone.id);
    } finally {
      await destroy(scope);
      await assertEmailCatchAllIsDisabled(api, zone.id);
    }
  });

  test("create catch-all with worker action", async (scope) => {
    try {
      const emailCatchAll = await EmailCatchAll(`${BRANCH_PREFIX}-worker-catchall`, {
        zone: zone.id,
        enabled: true,
        name: "Worker processing",
        actions: [
          {
            type: "worker",
            value: ["email-processor"],
          },
        ],
      });

      expect(emailCatchAll.actions[0].type).toBe("worker");
      expect(emailCatchAll.actions[0].value).toEqual(["email-processor"]);
    } finally {
      await destroy(scope);
      await assertEmailCatchAllIsDisabled(api, zone.id);
    }
  });

  test("create catch-all with custom matchers", async (scope) => {
    try {
      const emailCatchAll = await EmailCatchAll(`${BRANCH_PREFIX}-custom-catchall`, {
        zone: zone.id,
        enabled: true,
        name: "Custom catch-all",
        matchers: [
          {
            type: "literal",
            field: "to",
            value: "*@" + testDomain,
          },
        ],
        actions: [
          {
            type: "forward",
            value: [destinationEmail.email],
          },
        ],
      });

      expect(emailCatchAll.matchers[0].type).toBe("literal");
      expect(emailCatchAll.matchers[0].field).toBe("to");
      expect(emailCatchAll.matchers[0].value).toBe("*@" + testDomain);
    } finally {
      await destroy(scope);
      await assertEmailCatchAllIsDisabled(api, zone.id);
    }
  });

  test("default values", async (scope) => {
    try {
      const emailCatchAll = await EmailCatchAll(`${BRANCH_PREFIX}-default-catchall`, {
        zone: zone.id,
        // enabled not specified, should default to true
        // name not specified, should default to "Catch All"
        // matchers not specified, should default to [{ type: "all" }]
        actions: [
          {
            type: "forward",
            value: [destinationEmail.email],
          },
        ],
      });

      expect(emailCatchAll.enabled).toBe(true);
      expect(emailCatchAll.name).toBe("Catch All");
      expect(emailCatchAll.matchers).toEqual([{ type: "all" }]);
    } finally {
      await destroy(scope);
      await assertEmailCatchAllIsDisabled(api, zone.id);
    }
  });

  test("multiple actions", async (scope) => {
    try {
      const emailCatchAll = await EmailCatchAll(`${BRANCH_PREFIX}-multi-action-catchall`, {
        zone: zone.id,
        enabled: true,
        name: "Multi-action catch-all",
        actions: [
          {
            type: "forward",
            value: [destinationEmail.email, `backup-${BRANCH_PREFIX}@example.com`],
          },
          {
            type: "worker",
            value: ["log-all-emails"],
          },
        ],
      });

      expect(emailCatchAll.actions).toHaveLength(2);
      expect(emailCatchAll.actions[0].type).toBe("forward");
      expect(emailCatchAll.actions[0].value).toHaveLength(2);
      expect(emailCatchAll.actions[1].type).toBe("worker");
    } finally {
      await destroy(scope);
      await assertEmailCatchAllIsDisabled(api, zone.id);
    }
  });

  test("disable catch-all rule", async (scope) => {
    try {
      // Create enabled catch-all first
      await EmailCatchAll(`${BRANCH_PREFIX}-disable-test`, {
        zone: zone.id,
        enabled: true,
        actions: [
          {
            type: "forward",
            value: [destinationEmail.email],
          },
        ],
      });

      // Now disable it
      const emailCatchAll = await EmailCatchAll(`${BRANCH_PREFIX}-disable-test`, {
        zone: zone.id,
        enabled: false,
        actions: [
          {
            type: "drop",
          },
        ],
      });

      expect(emailCatchAll.enabled).toBe(false);

      // Verify via API
      const response = await api.get(
        `/zones/${zone.id}/email/routing/rules/catch_all`
      );
      expect(response.ok).toBe(true);

      const data: any = await response.json();
      expect(data.result.enabled).toBe(false);
    } finally {
      await destroy(scope);
      await assertEmailCatchAllIsDisabled(api, zone.id);
    }
  });
});

async function assertEmailCatchAllIsDisabled(api: any, zoneId: string) {
  const response = await api.get(`/zones/${zoneId}/email/routing/rules/catch_all`);
  if (response.ok) {
    const data: any = await response.json();
    expect(data.result.enabled).toBe(false);
  }
  // If the catch-all rule doesn't exist, that's also acceptable as "disabled"
}