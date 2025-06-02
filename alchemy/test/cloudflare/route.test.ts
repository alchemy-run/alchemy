import { afterAll, describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.js";
import { createCloudflareApi } from "../../src/cloudflare/api.js";
import { Route } from "../../src/cloudflare/route.js";
import { Worker } from "../../src/cloudflare/worker.js";
import { Zone } from "../../src/cloudflare/zone.js";
import { destroy } from "../../src/destroy.js";
import type { Scope } from "../../src/scope.js";
import { BRANCH_PREFIX } from "../util.js";
// must import this or else alchemy.test won't exist
import "../../src/test/vitest.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const testDomain = `${BRANCH_PREFIX}-route-test.com`;

let zone: Zone;
let scope: Scope | undefined;

test.beforeAll(async (_scope) => {
  zone = await Zone(`${BRANCH_PREFIX}-zone`, {
    name: testDomain,
  });
  scope = _scope;
});

afterAll(async () => {
  if (scope) {
    await destroy(scope);
  }
});

describe("Route Resource", () => {
  // Use BRANCH_PREFIX for deterministic, non-colliding resource names
  const testId = `${BRANCH_PREFIX}-test-route`;
  const pattern = `${testDomain}/*`;

  test("create, update, and delete route", async (scope) => {
    let route: any;
    let worker: any;
    let api: any;

    try {
      // Initialize API client
      api = await createCloudflareApi();

      // First create a worker to connect the route to
      const workerName = `${BRANCH_PREFIX}-worker-1`;
      worker = await Worker(workerName, {
        script: `
          export default {
            fetch(request, env) {
              return new Response('Hello from ${workerName}!');
            }
          }
        `,
      });

      expect(worker.name).toEqual(workerName);

      // Create a test route
      route = await Route(testId, {
        pattern,
        script: worker,
        zoneId: zone.id,
      });

      expect(route.id).toBeTruthy();
      expect(route.pattern).toEqual(pattern);
      expect(route.script).toEqual(workerName);

      // Verify route was created by querying the API directly
      const getResponse = await api.get(
        `/zones/${route.zoneId}/workers/routes/${route.id}`,
      );
      expect(getResponse.status).toEqual(200);

      const responseData = await getResponse.json();
      expect(responseData.result.pattern).toEqual(pattern);
      expect(responseData.result.script).toEqual(workerName);

      // Update the route with a new pattern
      const updatedPattern = pattern.replace("/*", "/api/*");

      route = await Route(testId, {
        pattern: updatedPattern,
        script: worker,
        zoneId: zone.id,
      });

      expect(route.id).toBeTruthy();
      expect(route.pattern).toEqual(updatedPattern);

      // Verify route was updated
      const getUpdatedResponse = await api.get(
        `/zones/${route.zoneId}/workers/routes/${route.id}`,
      );
      const updatedData = await getUpdatedResponse.json();
      expect(updatedData.result.pattern).toEqual(updatedPattern);
    } finally {
      // Always clean up, even if test assertions fail
      await destroy(scope);

      // Verify route was deleted
      if (route?.id && route?.zoneId) {
        await assertRouteNotExists(api, route.zoneId, route.id);
      }
    }
  });

  test("create route with string script name", async (scope) => {
    let route: any;
    let api: any;
    let worker: any;

    try {
      // Initialize API client
      api = await createCloudflareApi();

      // First create a worker to connect the route to
      const workerName = `${BRANCH_PREFIX}-worker-2`;
      worker = await Worker(workerName, {
        script: `
          export default {
            fetch(request, env) {
              return new Response('Hello from ${workerName}!');
            }
          }
        `,
      });

      expect(worker.name).toEqual(workerName);

      // Create a test route with a string script name
      route = await Route(`${testId}-string`, {
        pattern,
        script: workerName,
        zoneId: zone.id,
      });

      expect(route.id).toBeTruthy();
      expect(route.pattern).toEqual(pattern);
      expect(route.script).toEqual(workerName);

      // Verify route was created by querying the API directly
      const getResponse = await api.get(
        `/zones/${route.zoneId}/workers/routes/${route.id}`,
      );
      expect(getResponse.status).toEqual(200);

      const responseData = await getResponse.json();
      expect(responseData.result.pattern).toEqual(pattern);
      expect(responseData.result.script).toEqual(workerName);
    } finally {
      // Always clean up, even if test assertions fail
      await destroy(scope);

      // Verify route was deleted
      if (route?.id && route?.zoneId) {
        await assertRouteNotExists(api, route.zoneId, route.id);
      }
    }
  });

  test("using different patterns", async (scope) => {
    let route: any;
    let api: any;
    let worker: any;

    try {
      // Initialize API client
      api = await createCloudflareApi();

      // First create a worker to connect the route to
      const workerName = `${BRANCH_PREFIX}-worker-3`;
      worker = await Worker(workerName, {
        script: `
          export default {
            fetch(request, env) {
              return new Response('Hello from ${workerName}!');
            }
          }
        `,
      });

      expect(worker.name).toEqual(workerName);

      // Use a more specific pattern
      const specificPattern = `${testDomain}/api/*`;

      // Create a test route with a specific pattern
      route = await Route(`${testId}-specific-pattern`, {
        pattern: specificPattern,
        script: workerName,
        zoneId: zone.id,
      });

      expect(route.id).toBeTruthy();
      expect(route.pattern).toEqual(specificPattern);
      expect(route.script).toEqual(workerName);
      expect(route.zoneId).toEqual(zone.id);

      // Verify route was created by querying the API directly
      const getResponse = await api.get(
        `/zones/${route.zoneId}/workers/routes/${route.id}`,
      );
      expect(getResponse.status).toEqual(200);

      const responseData = await getResponse.json();
      expect(responseData.result.pattern).toEqual(specificPattern);
      expect(responseData.result.script).toEqual(workerName);
    } finally {
      // Always clean up, even if test assertions fail
      await destroy(scope);

      // Verify route was deleted
      if (route?.id && route?.zoneId) {
        await assertRouteNotExists(api, route.zoneId, route.id);
      }
    }
  });
});

/**
 * Asserts that a route does not exist by checking for a 404 status
 */
async function assertRouteNotExists(api: any, zoneId: string, routeId: string) {
  const getDeletedResponse = await api.get(
    `/zones/${zoneId}/workers/routes/${routeId}`,
  );
  expect(getDeletedResponse.status).toEqual(404);
}
