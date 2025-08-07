import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy";
import {
  type CloudflareApi,
  createCloudflareApi,
} from "../../src/cloudflare/api";
import {
  Tunnel,
  getTunnel,
  getTunnelConfiguration,
  listTunnels,
} from "../../src/cloudflare/tunnel";
import { destroy } from "../../src/destroy";
import { BRANCH_PREFIX } from "../util";
// must import this or else alchemy.test won't exist
import { Secret } from "../../src";
import "../../src/test/vitest";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const TEST_DOMAIN = process.env.TEST_DOMAIN ?? "alchemy-test.us";

describe("Tunnel Resource", () => {
  // Use BRANCH_PREFIX for deterministic, non-colliding resource names
  const testId = `${BRANCH_PREFIX}-test-tunnel`;

  test("create, update, and delete tunnel", async (scope) => {
    const api = await createCloudflareApi();
    let tunnel: Tunnel | undefined;

    try {
      // Create a tunnel with basic configuration
      tunnel = await Tunnel(testId, {
        name: `${testId}-initial`,
        ingress: [
          {
            hostname: `test.${TEST_DOMAIN}`,
            service: "http://localhost:8080",
          },
          {
            service: "http_status:404", // catch-all rule
          },
        ],
        adopt: true,
      });

      // Verify tunnel was created
      expect(tunnel).toMatchObject({
        tunnelId: expect.any(String),
        name: `${testId}-initial`,
        createdAt: expect.any(String),
        deletedAt: null,
        credentials: expect.any(Object),
        token: expect.any(Secret),
        ingress: expect.arrayContaining([
          expect.any(Object),
          expect.any(Object),
        ]),
      });

      // Verify tunnel exists via API
      expect(await getTunnel(api, tunnel.tunnelId)).toMatchObject({
        name: `${testId}-initial`,
      });

      // Verify configuration was applied
      expect(await getTunnelConfiguration(api, tunnel.tunnelId)).toMatchObject({
        ingress: expect.arrayContaining([
          expect.any(Object),
          expect.any(Object),
        ]),
      });

      // Update the tunnel with new configuration
      tunnel = await Tunnel(testId, {
        name: `${testId}-updated`,
        ingress: [
          {
            hostname: `app.${TEST_DOMAIN}`,
            service: "http://localhost:3000",
          },
          {
            hostname: `api.${TEST_DOMAIN}`,
            service: "http://localhost:8080",
            originRequest: {
              httpHostHeader: "api.internal",
              connectTimeout: 30,
            },
          },
          {
            service: "http_status:404",
          },
        ],
        warpRouting: {
          enabled: true,
        },
      });

      // Verify tunnel was updated
      expect(tunnel).toMatchObject({
        name: `${testId}-updated`,
        ingress: expect.arrayContaining([
          expect.any(Object),
          expect.any(Object),
          expect.any(Object),
        ]),
        warpRouting: {
          enabled: true,
        },
      });

      // Verify updated configuration via API
      expect(await getTunnelConfiguration(api, tunnel.tunnelId)).toMatchObject({
        ingress: expect.arrayContaining([
          expect.any(Object),
          expect.any(Object),
          expect.any(Object),
        ]),
        warpRouting: {
          enabled: true,
        },
      });
    } catch (err) {
      // Log the error or else it's silently swallowed by destroy errors
      console.error("Test error:", err);
      throw err;
    } finally {
      // Always clean up, even if test assertions fail
      await destroy(scope);

      await assertTunnelDeleted(api, tunnel?.tunnelId);
    }
  });
});

async function assertTunnelDeleted(api: CloudflareApi, tunnelId?: string) {
  if (tunnelId) {
    // we have to use list because getTunnel still returns data, but it won't be in list
    expect(
      (await listTunnels(api)).find((t) => t.id === tunnelId),
    ).toBeUndefined();
  }
}
