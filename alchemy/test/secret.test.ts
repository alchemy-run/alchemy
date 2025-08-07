import { inspect } from "node:util";
import { describe, expect, test } from "vitest";
import { alchemy } from "../src/alchemy.ts";
import { Secret, secret } from "../src/secret.ts";

describe("Secret", () => {
  test("toString prevents exposing secret values", () => {
    const secretValue = "super-secret-api-key";
    const mySecret = alchemy.secret(secretValue, "my-api-key");

    // Test toString
    const stringValue = mySecret.toString();
    expect(stringValue).toBe("Secret(my-api-key)");
    expect(stringValue).not.toContain(secretValue);
  });

  test("console.log uses custom inspect to prevent exposing secrets", () => {
    const secretValue = "another-secret-value";
    const mySecret = alchemy.secret(secretValue, "database-password");

    // Test inspect (used by console.log)
    const inspectedValue = inspect(mySecret);
    expect(inspectedValue).toBe("Secret(database-password)");
    expect(inspectedValue).not.toContain(secretValue);
  });

  test("string concatenation uses toString", () => {
    const secretValue = "concat-secret";
    const mySecret = alchemy.secret(secretValue, "concat-test");

    // Test string concatenation
    const concatenated = `Value: ${mySecret}`;
    expect(concatenated).toBe("Value: Secret(concat-test)");
    expect(concatenated).not.toContain(secretValue);
  });

  test("template literals use toString", () => {
    const secretValue = "template-secret";
    const mySecret = alchemy.secret(secretValue, "template-test");

    // Test template literals
    const templated = `Value: ${mySecret}`;
    expect(templated).toBe("Value: Secret(template-test)");
    expect(templated).not.toContain(secretValue);
  });

  test("anonymous secrets show generated name", () => {
    const secretValue = "my-confidential-value";
    const mySecret = alchemy.secret(secretValue); // No name provided

    // Test that it shows the generated name
    const stringValue = mySecret.toString();
    expect(stringValue).toMatch(/^Secret\(alchemy:anonymous-secret-\d+\)$/);
    expect(stringValue).not.toContain(secretValue);
  });

  test("JSON.stringify exposes the full object structure", () => {
    const secretValue = "json-secret";
    const mySecret = alchemy.secret(secretValue, "json-test");

    // Test JSON.stringify - it will use the object structure, not toString
    const jsonString = JSON.stringify(mySecret);
    const parsed = JSON.parse(jsonString);

    // The JSON representation WILL contain the unencrypted value
    // (only toString and console.log are protected)
    expect(jsonString).toContain(secretValue);
    expect(parsed.type).toBe("secret");
    expect(parsed.name).toBe("json-test");
    expect(parsed.unencrypted).toBe(secretValue);
  });

  test("secret.env wraps environment variables", () => {
    // Set up a test environment variable
    process.env.TEST_SECRET_VAR = "env-secret-value";

    // Test secret.env
    const envSecret = secret.env.TEST_SECRET_VAR;
    expect(envSecret).toBeInstanceOf(Secret);
    expect(envSecret.toString()).toBe("Secret(TEST_SECRET_VAR)");
    expect(envSecret.toString()).not.toContain("env-secret-value");

    // Clean up
    delete process.env.TEST_SECRET_VAR;
  });

  test("secret.env function call", () => {
    // Set up a test environment variable
    process.env.TEST_SECRET_FUNC = "func-secret-value";

    // Test secret.env as function
    const envSecret = secret.env("TEST_SECRET_FUNC");
    expect(envSecret).toBeInstanceOf(Secret);
    expect(envSecret.toString()).toBe("Secret(TEST_SECRET_FUNC)");
    expect(envSecret.toString()).not.toContain("func-secret-value");

    // Clean up
    delete process.env.TEST_SECRET_FUNC;
  });
});
