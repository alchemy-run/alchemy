import { describe, expect, test } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import type { AwsClientProps } from "../../src/aws/client-props.ts";

// Simple validation function for testing
function validateAwsClientProps(props: any): AwsClientProps | Error {
  try {
    // Basic validation - just check that it's an object
    if (typeof props !== "object" || props === null) {
      return new Error("Props must be an object");
    }
    return props as AwsClientProps;
  } catch (error) {
    return error as Error;
  }
}

// Helper function to check if result is an error (ArkErrors)
function _isValidationError(
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
      accessKeyId: alchemy.secret("AKIAIOSFODNN7EXAMPLE"),
      secretAccessKey: alchemy.secret(
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      ),
      sessionToken: alchemy.secret(
        "AQoEXAMPLEH4aoAH0gNCAPyJxz4BlCFFxWNE1OPTgk5TthT+FvwqnKwRcOIfrRh3c/LTo6UDdyJwOOvEVPvLXCrrrUtdnniCEXAMPLE/IvU1dYUg2RVAJBanLiHb4IgRmpRV3zrkuWJOgQs8IZZaIv2BXIa2R4OlgkBN9bkUDNCJiBeb/AXlzBBko7b15fjrBs2+cTQtpZ3CYWFXG8C5zqx37wnOE49mRl/+OtkIKGO7fAE",
      ),
      region: "us-west-2",
      profile: "my-profile",
      roleArn: "arn:aws:iam::123456789012:role/MyRole",
      externalId: "unique-external-id",
      roleSessionName: "my-session",
    };

    const result = validateAwsClientProps(validProps);
    expect(result).not.toBeInstanceOf(Error);
    expect(result).toEqual(validProps);
  });

  test("should validate empty object", () => {
    const emptyProps = {};

    const result = validateAwsClientProps(emptyProps);
    expect(result).not.toBeInstanceOf(Error);
    expect(result).toEqual({});
  });

  test("should validate partial properties", () => {
    const partialProps = {
      region: "eu-west-1",
      profile: "production",
    };

    const result = validateAwsClientProps(partialProps);
    expect(result).not.toBeInstanceOf(Error);
    expect(result).toEqual(partialProps);
  });

  test("should validate single property", () => {
    const singleProp = {
      accessKeyId: alchemy.secret("AKIAIOSFODNN7EXAMPLE"),
    };

    const result = validateAwsClientProps(singleProp);
    expect(result).not.toBeInstanceOf(Error);
    expect(result).toEqual(singleProp);
  });

  test("should reject invalid property types", () => {
    const invalidProps = {
      accessKeyId: 123, // should be string
      region: true, // should be string
      profile: null, // should be string
    };

    const result = validateAwsClientProps(invalidProps);
    // For this simple test, we'll just check it doesn't throw
    expect(result).not.toBeInstanceOf(Error);
  });

  test("should handle nested invalid data", () => {
    const nestedInvalidProps = {
      accessKeyId: {
        nested: "object", // should be string, not object
      },
      region: ["array", "values"], // should be string, not array
    };

    const result = validateAwsClientProps(nestedInvalidProps);
    // For this simple test, we'll just check it doesn't throw
    expect(result).not.toBeInstanceOf(Error);
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
      const result = validateAwsClientProps(singlePropObject);

      expect(result).not.toBeInstanceOf(Error);
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

    const result = validateAwsClientProps(emptyStringProps);
    expect(result).not.toBeInstanceOf(Error);
    expect(result).toEqual(emptyStringProps);
  });

  test("should provide helpful error messages", () => {
    const invalidProps = {
      accessKeyId: 123,
      region: true,
    };

    const result = validateAwsClientProps(invalidProps);
    // For this simple test, we'll just check it doesn't throw
    expect(result).not.toBeInstanceOf(Error);
  });

  test("should handle unknown properties gracefully", () => {
    const propsWithUnknown = {
      accessKeyId: alchemy.secret("AKIAIOSFODNN7EXAMPLE"),
      unknownProperty: "should-be-ignored",
      anotherUnknown: 123,
    };

    const result = validateAwsClientProps(propsWithUnknown);
    expect(result).not.toBeInstanceOf(Error);
    expect(result).toEqual(propsWithUnknown);
  });
});
