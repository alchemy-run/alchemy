import { afterAll, describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { createCloudflareApi } from "../../src/cloudflare/api.ts";
import { EmailRouting } from "../../src/cloudflare/email-routing.ts";
import { Zone } from "../../src/cloudflare/zone.ts";
import { destroy } from "../../src/destroy.ts";
import { BRANCH_PREFIX } from "../util.ts";

import type { Scope } from "../../src/scope.ts";
import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const testDomain = `${BRANCH_PREFIX}-email-test.com`;

let zone: Zone;
let scope: Scope | undefined;

test.beforeAll(async (_scope) => {
  zone = await Zone(`${BRANCH_PREFIX}-email-zone`, {
    name: testDomain,
  });
  scope = _scope;
});

afterAll(async () => {
  if (scope) {
    await destroy(scope);
  }
});

describe("EmailRouting Resource", async () => {
  const api = await createCloudflareApi();

  test("enable, update, and disable email routing", async (scope) => {
    let emailRouting;
    try {
      // Enable email routing
      emailRouting = await EmailRouting(`${BRANCH_PREFIX}-email-routing`, {
        zone: zone.id,
        enabled: true,
        skipWizard: true,
      });

      expect(emailRouting).toMatchObject({
        zoneId: zone.id,
        enabled: true,
        name: testDomain,
      });
      expect(emailRouting.created).toBeDefined();
      expect(emailRouting.modified).toBeDefined();
      expect(emailRouting.tag).toBeDefined();

      // Verify email routing is enabled by querying the API directly
      const response = await api.get(`/zones/${zone.id}/email/routing`);
      expect(response.ok).toBe(true);

      const data: any = await response.json();
      expect(data.result.enabled).toBe(true);
      expect(data.result.name).toBe(testDomain);

      // Update to keep enabled (should not change anything)
      emailRouting = await EmailRouting(`${BRANCH_PREFIX}-email-routing`, {
        zone: zone.id,
        enabled: true,
        skipWizard: true,
      });

      expect(emailRouting.enabled).toBe(true);

      // Update to disable
      emailRouting = await EmailRouting(`${BRANCH_PREFIX}-email-routing`, {
        zone: zone.id,
        enabled: false,
      });

      expect(emailRouting.enabled).toBe(false);

      // Verify disabled via API
      const disabledResponse = await api.get(`/zones/${zone.id}/email/routing`);
      if (disabledResponse.ok) {
        const disabledData: any = await disabledResponse.json();
        expect(disabledData.result.enabled).toBe(false);
      } else {
        // Email routing might be completely removed when disabled
        expect(disabledResponse.status).toBe(404);
      }
    } finally {
      await destroy(scope);
      await assertEmailRoutingDoesNotExist(api, zone.id);
    }
  });

  test("enable email routing with Zone resource reference", async (scope) => {
    try {
      const emailRouting = await EmailRouting(`${BRANCH_PREFIX}-email-routing-zone-ref`, {
        zone: zone, // Use Zone resource instead of string ID
        enabled: true,
        skipWizard: true,
      });

      expect(emailRouting).toMatchObject({
        zoneId: zone.id,
        enabled: true,
        name: testDomain,
      });
    } finally {
      await destroy(scope);
      await assertEmailRoutingDoesNotExist(api, zone.id);
    }
  });

  test("handle email routing already enabled", async (scope) => {
    try {
      // Enable email routing first
      await EmailRouting(`${BRANCH_PREFIX}-email-routing-existing-1`, {
        zone: zone.id,
        enabled: true,
        skipWizard: true,
      });

      // Try to enable again - should return existing configuration
      const emailRouting = await EmailRouting(`${BRANCH_PREFIX}-email-routing-existing-2`, {
        zone: zone.id,
        enabled: true,
        skipWizard: true,
      });

      expect(emailRouting.enabled).toBe(true);
      expect(emailRouting.zoneId).toBe(zone.id);
    } finally {
      await destroy(scope);
      await assertEmailRoutingDoesNotExist(api, zone.id);
    }
  });

  test("default enabled to true", async (scope) => {
    try {
      const emailRouting = await EmailRouting(`${BRANCH_PREFIX}-email-routing-default`, {
        zone: zone.id,
        // enabled not specified, should default to true
        skipWizard: true,
      });

      expect(emailRouting.enabled).toBe(true);
    } finally {
      await destroy(scope);
      await assertEmailRoutingDoesNotExist(api, zone.id);
    }
  });
});

async function assertEmailRoutingDoesNotExist(api: any, zoneId: string) {
  const response = await api.get(`/zones/${zoneId}/email/routing`);
  // Email routing should either be disabled or not found
  if (response.ok) {
    const data: any = await response.json();
    expect(data.result.enabled).toBe(false);
  } else {
    expect(response.status).toBe(404);
  }
}