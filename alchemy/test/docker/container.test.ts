import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy.js";
import { destroy } from "../../src/destroy.js";
import { DockerContainer } from "../../src/docker/container.js";

import "../../src/test/bun.js";

const test = alchemy.test(import.meta);

describe("DockerContainer", () => {
  test("should create a container without starting it", async (scope) => {
    try {
      // Create a container without starting it to avoid port conflicts
      const container = await DockerContainer("test-container", {
        image: "hello-world:latest",
        name: "alchemy-test-container",
        start: false
      });

      // Use type assertion since TypeScript doesn't recognize the properties
      const typedContainer = container as any;
      expect(typedContainer.name).toBe("alchemy-test-container");
      expect(typedContainer.state).toBe("created");
    } finally {
      await destroy(scope);
    }
  });
});

