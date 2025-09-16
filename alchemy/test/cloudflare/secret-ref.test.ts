import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { SecretRef } from "../../src/cloudflare/secret-ref.ts";
import { Secret } from "../../src/cloudflare/secret.ts";
import { Worker } from "../../src/cloudflare/worker.ts";
import { secret } from "../../src/secret.ts";
import "../../src/test/vitest.ts";
import { fetchAndExpectOK } from "../../src/util/safe-fetch.ts";
import { BRANCH_PREFIX } from "../util.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("SecretRef Resource", () => {
  test("bind SecretRef to worker and read referenced value", async (scope) => {
    const testId = `${BRANCH_PREFIX}-secret-ref`;
    const workerName = `${BRANCH_PREFIX}-secret-ref-worker`;

    let createdSecret: Secret | undefined;
    let ref: ReturnType<typeof SecretRef> extends Promise<infer T> ? T : never;
    let worker: Worker | undefined;

    try {
      // 1) Create a real secret in the default store
      createdSecret = await Secret(testId, {
        name: testId,
        value: secret("ref-secret-value"),
      });

      expect(createdSecret).toBeTruthy();
      expect(createdSecret.name).toEqual(testId);

      // 2) Reference the existing secret (no value provided)
      ref = await SecretRef({
        name: testId,
      });

      expect(ref.type).toEqual("secrets_store_secret");
      expect(ref.name).toEqual(testId);
      expect(ref.storeId).toBeTruthy();

      // 3) Bind the SecretRef to a worker and retrieve value at runtime
      worker = await Worker(workerName, {
        name: workerName,
        adopt: true,
        script: `
          export default {
            async fetch(request, env) {
              try {
                const secretValue = await env.TEST_SECRET_REF.get();
                return new Response(JSON.stringify({
                  secret: secretValue || "not-found",
                  secretName: "${testId}"
                }), { headers: { 'Content-Type': 'application/json' } });
              } catch (error) {
                return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
              }
            }
          };
        `,
        format: "esm",
        url: true,
        bindings: {
          TEST_SECRET_REF: ref,
        },
      });

      expect(worker.id).toBeTruthy();
      expect(worker.name).toEqual(workerName);
      expect(worker.url).toBeTruthy();

      // Wait briefly for deployment
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const response = await fetchAndExpectOK(worker.url!);
      const data: any = await response.json();
      expect(data.secret).toEqual("ref-secret-value");
      expect(data.secretName).toEqual(testId);
    } finally {
      await alchemy.destroy(scope);
    }
  });
});
