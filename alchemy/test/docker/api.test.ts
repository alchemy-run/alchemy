import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { DockerApi, normalizeDuration } from "../../src/docker/api.ts";
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

describe("normalizeDuration", () => {
  test("should convert number to seconds format", async (scope) => {
    try {
      expect(normalizeDuration(30)).toBe("30s");
      expect(normalizeDuration(0)).toBe("0s");
      expect(normalizeDuration(120)).toBe("120s");
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("should accept valid string duration with seconds", async (scope) => {
    try {
      expect(normalizeDuration("30s")).toBe("30s");
      expect(normalizeDuration("0s")).toBe("0s");
      expect(normalizeDuration("120s")).toBe("120s");
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("should accept valid string duration with milliseconds", async (scope) => {
    try {
      expect(normalizeDuration("500ms")).toBe("500ms");
      expect(normalizeDuration("1000ms")).toBe("1000ms");
      expect(normalizeDuration("100ms")).toBe("100ms");
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("should accept valid string duration with minutes", async (scope) => {
    try {
      expect(normalizeDuration("1m")).toBe("1m");
      expect(normalizeDuration("5m")).toBe("5m");
      expect(normalizeDuration("30m")).toBe("30m");
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("should accept valid string duration with hours", async (scope) => {
    try {
      expect(normalizeDuration("1h")).toBe("1h");
      expect(normalizeDuration("2h")).toBe("2h");
      expect(normalizeDuration("24h")).toBe("24h");
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("should accept decimal values", async (scope) => {
    try {
      expect(normalizeDuration("1.5s")).toBe("1.5s");
      expect(normalizeDuration("0.5m")).toBe("0.5m");
      expect(normalizeDuration("2.5h")).toBe("2.5h");
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("should throw error for invalid format", async (scope) => {
    try {
      // @ts-expect-error
      expect(() => normalizeDuration("invalid")).toThrow(
        /Invalid duration format/,
      );
      // @ts-expect-error
      expect(() => normalizeDuration("30")).toThrow(/Invalid duration format/);
      // @ts-expect-error
      expect(() => normalizeDuration("s30")).toThrow(/Invalid duration format/);
      // @ts-expect-error
      expect(() => normalizeDuration("30x")).toThrow(/Invalid duration format/);
      // @ts-expect-error
      expect(() => normalizeDuration("")).toThrow(/Invalid duration format/);
    } finally {
      await alchemy.destroy(scope);
    }
  });
});
