import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy.js";
import { destroy } from "../../src/destroy.js";
import { DockerNetwork } from "../../src/docker/network.js";

import "../../src/test/bun.js";

const test = alchemy.test(import.meta);

describe("DockerNetwork", () => {
  test("should create a test network with default driver", async (scope) => {
    try {
      const networkName = `alchemy-test-network-${Date.now()}`;
      const network = await DockerNetwork("test-network", {
        name: networkName
      });

      // Use type assertion for tests
      const typedNetwork = network as any;
      expect(typedNetwork.name).toBe(networkName);
      expect(typedNetwork.driver).toBe("bridge"); // default value
    } finally {
      await destroy(scope);
    }
  });
});
