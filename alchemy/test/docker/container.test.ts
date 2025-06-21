import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { Container } from "../../src/docker/container.ts";
import { BRANCH_PREFIX } from "../util.ts";

import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Container", () => {
  test("should create a container without starting it", async (scope) => {
    try {
      // Create a container without starting it to avoid port conflicts
      const container = await Container("test-container", {
        image: "hello-world:latest",
        name: "alchemy-test-container",
        start: false,
      });

      expect(container.name).toBe("alchemy-test-container");
      expect(container.state).toBe("created");
    } finally {
      await alchemy.destroy(scope);
    }
  });
});
