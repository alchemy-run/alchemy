import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.js";
import { RemoteImage } from "../../src/docker/remote-image.js";
import { BRANCH_PREFIX } from "../util.js";

import "../../src/test/vitest.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("RemoteImage", () => {
  test("should pull a small test image", async (scope) => {
    try {
      // Use a small test image to avoid long download times
      const image = await RemoteImage("hello-world-image", {
        name: "hello-world",
        tag: "latest",
      });

      expect(image.name).toBe("hello-world");
      expect(image.tag).toBe("latest");
      expect(image.imageRef).toBe("hello-world:latest");
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("should fail when using a non-existent tag", async (scope) => {
    try {
      expect(
        RemoteImage("non-existent-image", {
          name: "non-existent",
          tag: "test-tag-123",
        }),
      ).rejects.toThrow("Error pulling image non-existent:test-tag-123");
    } finally {
      await alchemy.destroy(scope);
    }
  });
});
