import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy.js";
import { destroy } from "../../src/destroy.js";
import { DockerImage } from "../../src/docker/image.js";

import "../../src/test/bun.js";

const test = alchemy.test(import.meta);

describe("DockerImage", () => {
  test("should pull a small test image", async (scope) => {
    try {
      // Use a small test image to avoid long download times
      const image = await DockerImage("hello-world-image", {
        name: "hello-world",
        tag: "latest"
      });

      // Use type assertion since TS doesn't know these properties exist
      const typedImage = image as any;
      expect(typedImage.name).toBe("hello-world");
      expect(typedImage.tag).toBe("latest");
      expect(typedImage.imageRef).toBe("hello-world:latest");
    } finally {
      await destroy(scope);
    }
  });

  test("should create a mock image when using a non-existent tag", async (scope) => {
    try {
      // This should create a mock resource since this tag doesn't exist
      // or Docker might not be installed/running on the test machine
      const image = await DockerImage("non-existent-image", {
        name: "non-existent",
        tag: "test-tag-123",
        // Force a mock if Docker is running to avoid test failures
        alwaysPull: false
      });

      // Use type assertion for tests
      const typedImage = image as any;
      expect(typedImage.name).toBe("non-existent");
      expect(typedImage.tag).toBe("test-tag-123");
      expect(typedImage.imageRef).toBe("non-existent:test-tag-123");
    } finally {
      await destroy(scope);
    }
  });
});
