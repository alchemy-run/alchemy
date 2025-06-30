import { afterAll, describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import {
  createCloudflareApi,
  type CloudflareApi,
} from "../../src/cloudflare/api.ts";
import { Worker } from "../../src/cloudflare/worker.ts";
import { Zone } from "../../src/cloudflare/zone.ts";
import { destroy } from "../../src/destroy.ts";
import type { Scope } from "../../src/scope.ts";
import { BRANCH_PREFIX } from "../util.ts";
// must import this or else alchemy.test won't exist
import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
  quiet: false,
});

const testDomain = `${BRANCH_PREFIX}-custom-domain-test.com`;

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

const api = await createCloudflareApi();

describe("Custom Domain", () => {
  test("should create a custom domain", async (scope) => {
    try {
      const worker = await Worker(`${BRANCH_PREFIX}-worker-1`, {
        domains: [`sub.${testDomain}`],
        script: `
          export default {
            fetch(request, env) {
              return new Response('Hello from ${BRANCH_PREFIX}-worker-1!');
            }
          }
        `,
        adopt: true,
      });

      expect(worker.domains?.[0]).toMatchObject({
        name: `sub.${testDomain}`,
        zoneId: zone.id,
      });
      await assertCustomDomain(api, worker, `sub.${testDomain}`);
    } finally {
      await destroy(scope);
    }
  });
});

export async function assertCustomDomain(
  api: CloudflareApi,
  worker: Worker,
  domain: string,
) {
  const domains = (await (
    await api.get(`/accounts/${api.accountId}/workers/domains`)
  ).json()) as {
    result: {
      hostname: string;
      zone_id: string;
      service: string;
      environment: string;
    }[];
  };
  expect(domains.result).toContainEqual(
    expect.objectContaining({
      hostname: domain,
      zone_id: zone.id,
      service: worker.name,
      environment: "production",
    }),
  );
}
