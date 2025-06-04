import type Stripe from "stripe";
import { beforeAll, describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { destroy } from "../../src/destroy.ts";
import { createStripeClient } from "../../src/stripe/client.ts";
import { File } from "../../src/stripe/file.ts";
import "../../src/test/vitest.ts";

const BRANCH_PREFIX = process.env.BRANCH_PREFIX || "test";

let stripeClient: Stripe;

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Stripe File Resource", () => {
  beforeAll(() => {
    const apiKey = process.env.STRIPE_API_KEY;
    if (!apiKey) {
      throw new Error("STRIPE_API_KEY environment variable is required");
    }
    stripeClient = createStripeClient({ apiKey });
  });

  test("create and retrieve file", async (scope) => {
    const fileId = `${BRANCH_PREFIX}-file-1`;

    const testFileContent = {
      data: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
        "base64",
      ),
      name: "test-file.png",
      type: "image/png",
    };
    try {
      const file = await File(fileId, {
        file: testFileContent,
        purpose: "dispute_evidence",
      });

      expect(file.purpose).toBe("dispute_evidence");
      expect(file.size).toBeGreaterThan(0);
      expect(file.object).toBe("file");

      const stripeFile = await stripeClient.files.retrieve(file.id);
      expect(stripeFile.id).toBe(file.id);
      expect(stripeFile.purpose).toBe("dispute_evidence");
    } finally {
      await destroy(scope);
    }
  });
});
