import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { Secret } from "../../src/cloudflare/secret.ts";
import { Worker } from "../../src/cloudflare/worker.ts";
import { secret } from "../../src/secret.ts";
import "../../src/test/vitest.ts";
import { fetchAndExpectOK } from "../../src/util/safe-fetch.ts";
import { BRANCH_PREFIX } from "../util.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Secret Resource", () => {
  // test("create default secrets store", async (scope) => {
  //   await SecretsStore("default-store", {
  //     name: "ubuntu-test-store-with-secrets",
  //     adopt: true,
  //   });

  //   await alchemy.destroy(scope);
  // });

  test("bind secret to worker and test end-to-end", async (scope) => {
    const testId = `${BRANCH_PREFIX}-test-secret`;
    const workerName = `${BRANCH_PREFIX}-secret-worker`;

    let testSecret: Secret | undefined;
    let worker: Worker | undefined;

    try {
      // Create a test secret in the default store
      testSecret = await Secret(testId, {
        value: secret("test-secret-value"),
      });

      expect(testSecret).toBeTruthy();
      expect(testSecret.name).toEqual(testId);
      expect(testSecret.value.unencrypted).toEqual("test-secret-value");

      // Create a worker that binds to the secret and returns the secret value
      worker = await Worker(workerName, {
        name: workerName,
        adopt: true,
        script: `
          export default {
            async fetch(request, env, ctx) {
              try {
                const secretValue = await env.TEST_SECRET.get();
                return new Response(JSON.stringify({
                  secret: secretValue || "not-found",
                  secretName: "${testId}"
                }), {
                  headers: { 'Content-Type': 'application/json' }
                });
              } catch (error) {
                return new Response(JSON.stringify({
                  error: error.message,
                  secretName: "${testId}"
                }), {
                  status: 500,
                  headers: { 'Content-Type': 'application/json' }
                });
              }
            }
          };
        `,
        format: "esm",
        url: true,
        bindings: {
          TEST_SECRET: testSecret,
        },
      });

      expect(worker.id).toBeTruthy();
      expect(worker.name).toEqual(workerName);
      expect(worker.url).toBeTruthy();

      // Wait for deployment to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Test the worker end-to-end
      const response = await fetchAndExpectOK(worker.url!);
      const data: any = await response.json();

      expect(data.secret).toEqual("test-secret-value");
      expect(data.secretName).toEqual(testId);
    } finally {
      await alchemy.destroy(scope);
    }
  });
});
