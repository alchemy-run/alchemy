import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy.ts";
import { destroy } from "../../src/destroy.ts";
import { R2Bucket } from "../../src/cloudflare/bucket.ts";
import { BRANCH_PREFIX } from "../util.ts";
import "../../src/test/bun.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("R2Bucket Name Change Validation", () => {
  const testId = `${BRANCH_PREFIX}-bucket-name-test`;

  test("should throw error when trying to change bucket name during update", async (scope) => {
    try {
      const bucket = await R2Bucket(testId, {
        name: `${testId}-original`,
        adopt: true,
      });

      expect(bucket.name).toEqual(`${testId}-original`);

      await expect(async () => {
        await R2Bucket(testId, {
          name: `${testId}-changed`,
        });
      }).toThrow(
        "Cannot update R2Bucket name after creation. Bucket name is immutable.",
      );
    } catch (err) {
      console.log(err);
      throw err;
    } finally {
      await destroy(scope);
    }
  });
});
