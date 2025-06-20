import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { DockerApi } from "../../src/docker/api.ts";
import { BRANCH_PREFIX } from "../util.ts";

import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("DockerApi", () => {
  test("should initialize with default docker path", async (scope) => {
    try {
      const dockerApi = new DockerApi();
      expect(dockerApi.dockerPath).toBe("docker");
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("should initialize with custom docker path", async (scope) => {
    try {
      const dockerApi = new DockerApi({ dockerPath: "/usr/local/bin/docker" });
      expect(dockerApi.dockerPath).toBe("/usr/local/bin/docker");
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("should execute docker command", async (scope) => {
    try {
      const dockerApi = new DockerApi();
      const result = await dockerApi.exec(["--version"]);

      expect(result).toHaveProperty("stdout");
      expect(result).toHaveProperty("stderr");
      // Docker version output should contain the word "Docker"
      expect(result.stdout.includes("Docker")).toBe(true);
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("should check if docker daemon is running", async (scope) => {
    try {
      const dockerApi = new DockerApi();
      const isRunning = await dockerApi.isRunning();

      // This might be true or false depending on whether Docker is installed and running
      // Just ensure it returns a boolean
      expect(typeof isRunning).toBe("boolean");
    } finally {
      await alchemy.destroy(scope);
    }
  });
});
