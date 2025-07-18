import { describe, expect, test } from "vitest";
import {
  AwsClientPropsSchema,
  type AwsClientProps,
} from "../../src/aws/client-props.ts";

// Helper function to check if result is an error (ArkErrors)
function isValidationError(
  result: any,
): result is { length: number; [key: string]: any } {
  return (
    result &&
    typeof result === "object" &&
    "length" in result &&
    Array.isArray(result)
  );
}

describe("AWS Client Props Schema Validation", () => {
  test("should validate valid AWS client properties", () => {
    const validProps: AwsClientProps = {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      sessionToken:
        "AQoEXAMPLEH4aoAH0gNCAPyJxz4BlCFFxWNE1OPTgk5TthT+FvwqnKwRcOIfrRh3c/LTo6UDdyJwOOvEVPvLXCrrrUtdnniCEXAMPLE/IvU1dYUg2RVAJBanLiHb4IgRmpRV3zrkuWJOgQs8IZZaIv2BXIa2R4OlgkBN9bkUDNCJiBeb/AXlzBBko7b15fjrBs2+cTQtpZ3CYWFXG8C5zqx37wnOE49mRl/+OtkIKGO7fAE",
      region: "us-west-2",
      profile: "my-profile",
      roleArn: "arn:aws:iam::123456789012:role/MyRole",
      externalId: "unique-external-id",
      roleSessionName: "my-session",
    };

    const result = AwsClientPropsSchema(validProps);
    expect(isValidationError(result)).toBe(false);
    expect(result).toEqual(validProps);
  });

  test("should validate empty object", () => {
    const emptyProps = {};

    const result = AwsClientPropsSchema(emptyProps);
    expect(isValidationError(result)).toBe(false);
    expect(result).toEqual({});
  });

  test("should validate partial properties", () => {
    const partialProps = {
      region: "eu-west-1",
      profile: "production",
    };

    const result = AwsClientPropsSchema(partialProps);
    expect(isValidationError(result)).toBe(false);
    expect(result).toEqual(partialProps);
  });

  test("should validate single property", () => {
    const singleProp = {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    };

    const result = AwsClientPropsSchema(singleProp);
    expect(isValidationError(result)).toBe(false);
    expect(result).toEqual(singleProp);
  });

  test("should reject invalid property types", () => {
    const invalidProps = {
      accessKeyId: 123, // should be string
      region: true, // should be string
      profile: null, // should be string
    };

    const result = AwsClientPropsSchema(invalidProps);
    expect(isValidationError(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(3);

    // Check that all three invalid properties are reported
    const problemPaths = result
      .map((error: any) => error.path?.[0])
      .filter(Boolean);
    expect(problemPaths).toContain("accessKeyId");
    expect(problemPaths).toContain("region");
    expect(problemPaths).toContain("profile");
  });

  test("should handle nested invalid data", () => {
    const nestedInvalidProps = {
      accessKeyId: {
        nested: "object", // should be string, not object
      },
      region: ["array", "values"], // should be string, not array
    };

    const result = AwsClientPropsSchema(nestedInvalidProps);
    expect(isValidationError(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  test("should validate all AWS credential properties individually", () => {
    const properties = [
      "accessKeyId",
      "secretAccessKey",
      "sessionToken",
      "region",
      "profile",
      "roleArn",
      "externalId",
      "roleSessionName",
    ];

    for (const prop of properties) {
      const singlePropObject = { [prop]: "test-value" };
      const result = AwsClientPropsSchema(singlePropObject);

      expect(
        isValidationError(result),
        `Property ${prop} should be valid`,
      ).toBe(false);
      expect(result).toEqual(singlePropObject);
    }
  });

  test("should handle edge cases with empty strings", () => {
    const emptyStringProps = {
      accessKeyId: "",
      secretAccessKey: "",
      region: "",
      profile: "",
    };

    const result = AwsClientPropsSchema(emptyStringProps);
    expect(isValidationError(result)).toBe(false);
    expect(result).toEqual(emptyStringProps);
  });

  test("should provide helpful error messages", () => {
    const invalidProps = {
      accessKeyId: 123,
      region: true,
    };

    const result = AwsClientPropsSchema(invalidProps);
    expect(isValidationError(result)).toBe(true);

    // Check that error messages are informative
    const errorMessages = result.map(
      (error: any) => error.message || error.toString(),
    );
    expect(errorMessages.some((msg: string) => msg.includes("string"))).toBe(
      true,
    );
  });

  test("should ignore unknown properties by default", () => {
    // Note: arktype v2 ignores unknown properties by default
    const propsWithUnknown = {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      unknownProperty: "should-be-ignored",
      anotherUnknown: 123,
    };

    const result = AwsClientPropsSchema(propsWithUnknown);
    expect(isValidationError(result)).toBe(false);

    // The result should contain the valid properties and ignore unknown ones
    expect(result).toEqual({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      unknownProperty: "should-be-ignored",
      anotherUnknown: 123,
    });
  });
});
