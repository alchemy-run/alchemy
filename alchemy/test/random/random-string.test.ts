import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { destroy } from "../../src/destroy.ts";
import { RandomString } from "../../src/random/random-string.ts";
import { BRANCH_PREFIX } from "../util.ts";
// must import this or else alchemy.test won't exist
import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("RandomString Resource", () => {
  // Use BRANCH_PREFIX for deterministic, non-colliding resource names
  const testRandomStringId = `${BRANCH_PREFIX}-random-string`;

  test("create random string with default settings", async (scope) => {
    let randomString: RandomString;
    try {
      // Create a test random string with defaults
      randomString = await RandomString(testRandomStringId);

      // Verify resource was created with defaults
      expect(randomString).toBeDefined();
      expect(randomString.value).toBeDefined();
      expect(randomString.length).toBe(32); // default length
      expect(randomString.encoding).toBe("hex"); // default encoding

      // Verify the value is a secret (has unencrypted property)
      expect(randomString.value.unencrypted).toBeDefined();

      // Verify the actual string length (32 bytes * 2 for hex = 64 chars)
      const stringValue = randomString.value.unencrypted;
      expect(stringValue.length).toBe(64);
      expect(stringValue).toMatch(/^[0-9a-f]+$/); // hex characters only
    } catch (err) {
      // log the error or else it's silently swallowed by destroy errors
      console.log(err);
      throw err;
    } finally {
      // Always clean up
      await destroy(scope);
    }
  });

  test("create random string with custom length", async (scope) => {
    let randomString: RandomString;
    try {
      // Create a test random string with custom length
      randomString = await RandomString(`${testRandomStringId}-custom-length`, {
        length: 16,
        encoding: "hex",
      });

      // Verify resource was created with custom settings
      expect(randomString).toBeDefined();
      expect(randomString.length).toBe(16);
      expect(randomString.encoding).toBe("hex");

      // Verify the actual string length (16 bytes * 2 for hex = 32 chars)
      const stringValue = randomString.value.unencrypted;
      expect(stringValue.length).toBe(32);
      expect(stringValue).toMatch(/^[0-9a-f]+$/);
    } catch (err) {
      console.log(err);
      throw err;
    } finally {
      await destroy(scope);
    }
  });

  test("create random string with base64 encoding", async (scope) => {
    let randomString: RandomString;
    try {
      // Create a test random string with base64 encoding
      randomString = await RandomString(`${testRandomStringId}-base64`, {
        length: 24,
        encoding: "base64",
      });

      // Verify resource was created with base64 encoding
      expect(randomString).toBeDefined();
      expect(randomString.length).toBe(24);
      expect(randomString.encoding).toBe("base64");

      // Verify the value format (base64 characters)
      const stringValue = randomString.value.unencrypted;
      expect(stringValue).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64 characters with optional padding

      // Base64 encoding of 24 bytes should be 32 characters (24 * 4/3)
      expect(stringValue.length).toBe(32);
    } catch (err) {
      console.log(err);
      throw err;
    } finally {
      await destroy(scope);
    }
  });

  test("update with same props (no-op)", async (scope) => {
    let randomString1: RandomString;
    let randomString2: RandomString;
    try {
      // Create initial random string
      randomString1 = await RandomString(`${testRandomStringId}-noop`, {
        length: 16,
        encoding: "hex",
      });

      const originalValue = randomString1.value.unencrypted;
      expect(originalValue).toBeDefined();
      expect(originalValue.length).toBe(32); // 16 bytes * 2

      // Update with same props - should be a no-op
      randomString2 = await RandomString(`${testRandomStringId}-noop`, {
        length: 16,
        encoding: "hex",
      });

      const updatedValue = randomString2.value.unencrypted;

      // Values should be identical (no-op update)
      expect(updatedValue).toBe(originalValue);
      expect(randomString2.length).toBe(16);
      expect(randomString2.encoding).toBe("hex");
    } catch (err) {
      console.log(err);
      throw err;
    } finally {
      await destroy(scope);
    }
  });

  test("update with different length regenerates value", async (scope) => {
    let randomString1: RandomString;
    let randomString2: RandomString;
    try {
      // Create initial random string
      randomString1 = await RandomString(`${testRandomStringId}-regen-length`, {
        length: 16,
        encoding: "hex",
      });

      const originalValue = randomString1.value.unencrypted;
      expect(originalValue.length).toBe(32); // 16 bytes * 2

      // Update with different length - should regenerate
      randomString2 = await RandomString(`${testRandomStringId}-regen-length`, {
        length: 32, // changed
        encoding: "hex",
      });

      const updatedValue = randomString2.value.unencrypted;

      // Values should be different (regenerated)
      expect(updatedValue).not.toBe(originalValue);
      expect(updatedValue.length).toBe(64); // 32 bytes * 2
      expect(randomString2.length).toBe(32);
    } catch (err) {
      console.log(err);
      throw err;
    } finally {
      await destroy(scope);
    }
  });

  test("update with different encoding regenerates value", async (scope) => {
    let randomString1: RandomString;
    let randomString2: RandomString;
    try {
      // Create initial random string
      randomString1 = await RandomString(
        `${testRandomStringId}-regen-encoding`,
        {
          length: 24,
          encoding: "hex",
        },
      );

      const originalValue = randomString1.value.unencrypted;
      expect(originalValue).toMatch(/^[0-9a-f]+$/);

      // Update with different encoding - should regenerate
      randomString2 = await RandomString(
        `${testRandomStringId}-regen-encoding`,
        {
          length: 24,
          encoding: "base64", // changed
        },
      );

      const updatedValue = randomString2.value.unencrypted;

      // Values should be different (regenerated) and in different format
      expect(updatedValue).not.toBe(originalValue);
      expect(updatedValue).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64 format
      expect(randomString2.encoding).toBe("base64");
    } catch (err) {
      console.log(err);
      throw err;
    } finally {
      await destroy(scope);
    }
  });

  test("multiple random strings have different values", async (scope) => {
    let randomString1: RandomString;
    let randomString2: RandomString;
    try {
      // Create two random strings with same settings but different IDs
      randomString1 = await RandomString(`${testRandomStringId}-unique-1`, {
        length: 16,
        encoding: "hex",
      });

      randomString2 = await RandomString(`${testRandomStringId}-unique-2`, {
        length: 16,
        encoding: "hex",
      });

      const value1 = randomString1.value.unencrypted;
      const value2 = randomString2.value.unencrypted;

      // Values should be different (cryptographically random)
      expect(value1).not.toBe(value2);
      expect(value1.length).toBe(32);
      expect(value2.length).toBe(32);
    } catch (err) {
      console.log(err);
      throw err;
    } finally {
      await destroy(scope);
    }
  });

  test("values are consistent across reads", async (scope) => {
    let randomString: RandomString;
    try {
      // Create a random string
      randomString = await RandomString(`${testRandomStringId}-consistent`);

      const value1 = randomString.value.unencrypted;
      const value2 = randomString.value.unencrypted;
      const value3 = randomString.value.unencrypted;

      // Multiple reads should return the same value
      expect(value1).toBe(value2);
      expect(value2).toBe(value3);
    } catch (err) {
      console.log(err);
      throw err;
    } finally {
      await destroy(scope);
    }
  });
});
