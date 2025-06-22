import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { Network } from "../../src/docker/network.ts";
import { BRANCH_PREFIX } from "../util.ts";

import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Network", () => {
  test("should create a test network with default driver", async (scope) => {
    try {
      const networkName = `alchemy-test-network-${Date.now()}`;
      const network = await Network("test-network", {
        name: networkName,
      });

      expect(network.name).toBe(networkName);
      expect(network.driver).toBe("bridge"); // default value
    } finally {
      await alchemy.destroy(scope);
    }
  });
});
