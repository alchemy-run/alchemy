import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy";
import { destroy } from "../../src/destroy";
import { Exec } from "../../src/os/exec";

import "../../src/test/bun";

const test = alchemy.test(import.meta);

describe("Exec Resource", () => {
  test("execute a simple command", async (scope) => {
    try {
      // Run a simple command
      const result = await Exec("echo-test", {
        command: "echo 'Hello, Alchemy!'",
        inheritStdio: false,
      });

      expect(result.id).toBe("echo-test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("Hello, Alchemy!");
      expect(result.stderr).toBe("");
      expect(result.completed).toBe(true);
    } finally {
      await destroy(scope);
    }
  });

  test("execute a command with environment variables", async (scope) => {
    try {
      // Run a command with custom environment variables
      const result = await Exec("env-test", {
        command: "echo $TEST_VAR",
        env: { TEST_VAR: "Custom Environment Variable" },
        inheritStdio: false,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("Custom Environment Variable");
    } finally {
      await destroy(scope);
    }
  });

  test("execute a command that fails", async (scope) => {
    try {
      // Run a command that will fail
      const result = Exec("fail-test", {
        command: "command-that-does-not-exist",
        inheritStdio: false,
      });
      await expect(result).rejects.toThrow();
    } finally {
      await destroy(scope);
    }
  });

  test("execute a command with a specific working directory", async (scope) => {
    try {
      // Run a command in a specific directory
      const result = await Exec("pwd-test", {
        command: "pwd",
        cwd: "/tmp",
        inheritStdio: false,
      });

      expect(result.exitCode).toBe(0);
      // On macOS, /tmp is a symlink to /private/tmp
      const expectedPath =
        process.platform === "darwin" ? "/private/tmp" : "/tmp";
      expect(result.stdout.trim()).toBe(expectedPath);
    } finally {
      await destroy(scope);
    }
  });

  test("memoize a command", async (scope) => {
    try {
      // Create a command with timestamp to verify it's not re-run
      const timestampCmd = `echo "Timestamp: $(date +%s)"`;

      // First execution
      const firstRun = await Exec("memoize-test", {
        command: timestampCmd,
        memoize: true,
        inheritStdio: false,
      });

      expect(firstRun.exitCode).toBe(0);
      expect(firstRun.stdout).toContain("Timestamp:");

      // Small delay to ensure timestamp would change if re-run
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Second execution with the same command
      const secondRun = await Exec("memoize-test", {
        command: timestampCmd,
        memoize: true,
        inheritStdio: false,
      });

      // The output should be identical since it should be memoized
      expect(secondRun.stdout).toBe(firstRun.stdout);
      expect(secondRun.executedAt).toBe(firstRun.executedAt);

      // Third execution with a different command
      const thirdRun = await Exec("memoize-test", {
        command: `echo "Different command: $(date +%s)"`,
        memoize: true,
        inheritStdio: false,
      });

      // This should execute and have different output
      expect(thirdRun.stdout).not.toBe(secondRun.stdout);
      expect(thirdRun.executedAt).not.toBe(secondRun.executedAt);
    } finally {
      await destroy(scope);
    }
  });
});
