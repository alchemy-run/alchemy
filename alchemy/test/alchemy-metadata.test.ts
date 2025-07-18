import { describe, expect, test } from "vitest";
import { alchemy } from "../src/alchemy.ts";

describe("Alchemy Metadata Integration", () => {
  test("should pass metadata through alchemy() function to scope", async () => {
    const app = await alchemy("test-app", {
      stage: "test",
      quiet: true,
      telemetry: false,
      // Arbitrary metadata properties
      awsRegion: "us-west-2",
      awsProfile: "test-profile",
      customConfig: { nested: { value: 42 } },
      stringValue: "test-string",
      numberValue: 123,
      booleanValue: true,
      arrayValue: [1, 2, 3],
    });

    try {
      // The root scope should have the metadata
      expect(app.metadata).toEqual({
        awsRegion: "us-west-2",
        awsProfile: "test-profile",
        customConfig: { nested: { value: 42 } },
        stringValue: "test-string",
        numberValue: 123,
        booleanValue: true,
        arrayValue: [1, 2, 3],
      });

      // Known properties should not be in metadata
      expect(app.metadata).not.toHaveProperty("stage");
      expect(app.metadata).not.toHaveProperty("quiet");
      expect(app.metadata).not.toHaveProperty("telemetry");
      expect(app.metadata).not.toHaveProperty("appName");
    } finally {
      await app.finalize();
    }
  });

  test("should handle empty metadata in alchemy() function", async () => {
    const app = await alchemy("test-app-empty", {
      stage: "test",
      quiet: true,
      telemetry: false,
    });

    try {
      expect(app.metadata).toEqual({});
    } finally {
      await app.finalize();
    }
  });

  test("should merge CLI options with metadata correctly", async () => {
    // Mock process.argv to simulate CLI arguments
    const originalArgv = process.argv;
    process.argv = ["node", "script.js", "--quiet"];

    try {
      const app = await alchemy("test-app-cli", {
        stage: "test",
        telemetry: false,
        // Custom metadata
        awsRegion: "eu-west-1",
        customValue: "from-options",
      });

      try {
        // CLI options should be applied (quiet: true from CLI)
        expect(app.quiet).toBe(true);

        // Metadata should still be preserved
        expect(app.metadata).toEqual({
          awsRegion: "eu-west-1",
          customValue: "from-options",
        });
      } finally {
        await app.finalize();
      }
    } finally {
      process.argv = originalArgv;
    }
  });
});
