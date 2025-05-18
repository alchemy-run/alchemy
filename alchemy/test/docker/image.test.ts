import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy.js";
import { destroy } from "../../src/destroy.js";
import { DockerRemoteImage } from "../../src/docker/image.js";

import "../../src/test/bun.js";

const test = alchemy.test(import.meta);

describe("DockerRemoteImage", () => {
  test("should pull a small test image", async (scope) => {
    try {
      // Use a small test image to avoid long download times
      const image = await DockerRemoteImage("hello-world-image", {
        name: "hello-world",
        tag: "latest"
      });

      expect(image.name).toBe("hello-world");
      expect(image.tag).toBe("latest");
      expect(image.imageRef).toBe("hello-world:latest");
    } finally {
      await destroy(scope);
    }
  });

  test("should fail when using a non-existent tag", async (scope) => {
    expect.assertions(1);
    try {
      await DockerRemoteImage("non-existent-image", {
        name: "non-existent",
        tag: "test-tag-123",
      });
    } catch (error) {
      expect(error).toBeDefined();
    } finally {
      await destroy(scope);
    }
  });
});
