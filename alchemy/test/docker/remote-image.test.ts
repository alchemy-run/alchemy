import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { RemoteImage } from "../../src/docker/remote-image.ts";
import { BRANCH_PREFIX } from "../util.ts";

import "../../src/test/vitest.ts";

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
      await expect(
        RemoteImage("non-existent-image", {
          name: "non-existent",
          tag: "test-tag-123",
        }),
      ).rejects.toThrow(
        /Error response from daemon: pull access denied for non-existent, repository does not exist or may require 'docker login'/,
      );
    } finally {
      await alchemy.destroy(scope);
    }
  });
});
