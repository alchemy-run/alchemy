import { afterAll, describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { CloudflareApiError } from "../../src/cloudflare/api-error.ts";
import { createCloudflareApi } from "../../src/cloudflare/api.ts";
import { Route } from "../../src/cloudflare/route.ts";
import { Worker } from "../../src/cloudflare/worker.ts";
import { Zone } from "../../src/cloudflare/zone.ts";
import { destroy } from "../../src/destroy.ts";
import type { Scope } from "../../src/scope.ts";
import { BRANCH_PREFIX } from "../util.ts";
// must import this or else alchemy.test won't exist
import "../../src/test/vitest.ts";

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

  test("create, update, and delete route", async (scope) => {
    let route: any;
    let worker: any;
    let api: any;
    const pattern = `${testDomain}/test1/*`;

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
        adopt: true,
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
      const updatedPattern = `${testDomain}/test1/api/*`;

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
    const pattern = `${testDomain}/test2/*`;

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

      // Use a more specific pattern - unique for this test
      const specificPattern = `${testDomain}/test3/api/*`;

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

  test("adopt existing route", async (scope) => {
    let route1: any;
    let route2: any;
    let api: any;
    let worker: any;
    const pattern = `${testDomain}/test4/*`;

    try {
      // Initialize API client
      api = await createCloudflareApi();

      // First create a worker to connect the route to
      const workerName = `${BRANCH_PREFIX}-worker-4`;
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

      // Create the first route
      route1 = await Route(`${testId}-adopt-1`, {
        pattern,
        script: workerName,
        zoneId: zone.id,
      });

      expect(route1.id).toBeTruthy();
      expect(route1.pattern).toEqual(pattern);

      // Try to create a second route with the same pattern - this should fail without adopt
      try {
        await Route(`${testId}-adopt-2-fail`, {
          pattern,
          script: workerName,
          zoneId: zone.id,
        });
        // Should not reach here
        expect(true).toBe(false);
      } catch (error: any) {
        // Expected to fail with 409 conflict
        expect(error).toBeInstanceOf(CloudflareApiError);
        expect(error.status).toBe(409);
      }

      // Now create a second route with adopt=true - this should succeed and adopt the existing route
      route2 = await Route(`${testId}-adopt-2-success`, {
        pattern,
        script: workerName,
        zoneId: zone.id,
        adopt: true,
      });

      expect(route2.id).toBeTruthy();
      expect(route2.pattern).toEqual(pattern);
      expect(route2.script).toEqual(workerName);

      // The adopted route should have the same ID as the original
      expect(route2.id).toEqual(route1.id);

      // Verify route exists by querying the API directly
      const getResponse = await api.get(
        `/zones/${route2.zoneId}/workers/routes/${route2.id}`,
      );
      expect(getResponse.status).toEqual(200);

      const responseData = await getResponse.json();
      expect(responseData.result.pattern).toEqual(pattern);
      expect(responseData.result.script).toEqual(workerName);
    } finally {
      // Always clean up, even if test assertions fail
      await destroy(scope);

      // Verify route was deleted
      if (route2?.id && route2?.zoneId) {
        await assertRouteNotExists(api, route2.zoneId, route2.id);
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
