import { describe } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { RateLimit } from "../../src/cloudflare/rate-limit.ts";
import { Worker } from "../../src/cloudflare/worker.ts";
import { fetchAndExpectStatus } from "../../src/util/safe-fetch.ts";
import { BRANCH_PREFIX } from "../util.ts";

import { destroy } from "../../src/destroy.ts";
import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("RateLimit", () => {
  test("end-to-end rate limiting with worker binding", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-rate-limit-test`;
    const rateLimitNamespaceId = 1001;

    try {
      const rateLimit = RateLimit({
        namespace_id: rateLimitNamespaceId,
        simple: {
          limit: 2,
          period: 60,
        },
      });

      const worker = await Worker(workerName, {
        name: workerName,
        adopt: true,
        url: true,
        script: `export default {
    async fetch(request, env) {
        const { pathname } = new URL(request.url);

        console.log(env.MY_RATE_LIMIT);

				try {
					const { success } = await env.MY_RATE_LIMIT.limit({ key: "test" });
					return new Response("Success!");
        } catch (error) {
          return new Response("Error!", { status: 500 });
        }
    },
};`,
        bindings: {
          MY_RATE_LIMIT: rateLimit,
        },
      });

      await fetchAndExpectStatus(worker.url!, undefined, 200);
    } finally {
      await destroy(scope);
    }
  });
});
