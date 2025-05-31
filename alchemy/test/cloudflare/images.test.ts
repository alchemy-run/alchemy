import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy.js";
import { destroy } from "../../src/destroy.js";
import { Images } from "../../src/cloudflare/images.js";
import { BRANCH_PREFIX } from "../util.js";
import "../../src/test/bun.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX
});

describe("Images Resource", () => {
  const testId = `${BRANCH_PREFIX}-test-images`;

  test("create and delete images binding", async (scope) => {
    let images: Awaited<ReturnType<typeof Images>> | undefined;
    try {
      images = await Images(testId, {});

      expect(images.id).toEqual(testId);
      expect(images.type).toEqual("images");
      expect(images.createdAt).toBeTruthy();

      expect(images).toBeTruthy();
    } catch(err) {
      console.log(err);
      throw err;
    } finally {
      await destroy(scope);
    }
  });
});
