import { describe, expect } from "bun:test";
import { Secret } from "../../src/secret";
import { deserialize, serialize } from "../../src/util/serde";

import { alchemy } from "../../src/alchemy";
import "../../src/test/bun";
import { BRANCH_PREFIX } from "../util";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("serde", () => {
  test("serializes and deserializes primitive values", async (scope) => {
    // Test primitive values
    const testCases = [42, "hello", true, null, undefined];

    for (const value of testCases) {
      const serialized = await serialize(scope, value);
      const deserialized = await deserialize(scope, serialized);
      expect(deserialized).toEqual(value);
    }
  });

  test("serializes and deserializes arrays", async (scope) => {
    const array = [1, "two", true, null];

    const serialized = await serialize(scope, array);
    const deserialized = await deserialize(scope, serialized);
    expect(deserialized).toEqual(array);
  });

  test("serializes and deserializes nested objects", async (scope) => {
    const obj = {
      a: 1,
      b: {
        c: "hello",
        d: [1, 2, 3],
        e: {
          f: true,
        },
      },
    };

    const serialized = await serialize(scope, obj);
    const deserialized = await deserialize(scope, serialized);
    expect(deserialized).toEqual(obj);
  });

  test("serializes and deserializes secrets", async (scope) => {
    const secret = alchemy.secret("sensitive-data");

    const serialized = await serialize(scope, secret);
    expect(serialized).toHaveProperty("@secret");
    expect(typeof serialized["@secret"]).toBe("string");
    expect(serialized["@secret"]).not.toContain("sensitive-data");

    const deserialized = await deserialize(scope, serialized);
    expect(deserialized).toBeInstanceOf(Secret);
    expect(deserialized.unencrypted).toBe("sensitive-data");
  });

  test("serializes scope to undefined", async (scope) => {
    const objWithScope = {
      scope: scope,
      data: "test",
    };

    const serialized = await serialize(scope, objWithScope);
    expect(serialized).toEqual({
      scope: undefined,
      data: "test",
    });
  });

  test("handles complex objects with secrets", async (scope) => {
    const complexObj = {
      name: "test",
      credentials: {
        username: "user",
        password: alchemy.secret("super-secret"),
        apiKey: alchemy.secret("api-key-123"),
      },
      settings: {
        enabled: true,
        tokens: [alchemy.secret("token1"), alchemy.secret("token2")],
      },
    };

    const serialized = await serialize(scope, complexObj);
    const deserialized = await deserialize(scope, serialized);

    // Verify structure
    expect(deserialized).toHaveProperty("name", "test");
    expect(deserialized.credentials.username).toBe("user");
    expect(deserialized.credentials.password).toBeInstanceOf(Secret);
    expect(deserialized.credentials.password.unencrypted).toBe("super-secret");
    expect(deserialized.credentials.apiKey.unencrypted).toBe("api-key-123");
    expect(deserialized.settings.enabled).toBe(true);

    expect(deserialized.settings.tokens[0].unencrypted).toBe("token1");
    expect(deserialized.settings.tokens[1].unencrypted).toBe("token2");
  });

  test("props", async (scope) => {
    const props = {
      name: "alchemy.run",
      type: "full",
    };

    const serialized = await serialize(scope, props);
    console.log(serialized);
  });
});
