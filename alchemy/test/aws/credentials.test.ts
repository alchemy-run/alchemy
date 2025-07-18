import { describe, expect, test } from "vitest";
import type { AwsClientProps } from "../../src/aws/client-props.ts";
import {
  getGlobalAwsConfig,
  resolveAwsCredentials,
} from "../../src/aws/credentials.ts";
import { Scope } from "../../src/scope.ts";
import { TelemetryClient } from "../../src/util/telemetry/client.ts";

// Helper function to temporarily set environment variables for a test
function withEnv<T>(
  envVars: Record<string, string | undefined>,
  fn: () => T,
): T {
  const originalValues: Record<string, string | undefined> = {};

  // Store original values and set new ones
  Object.keys(envVars).forEach((key) => {
    originalValues[key] = process.env[key];
    if (envVars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = envVars[key];
    }
  });

  try {
    return fn();
  } finally {
    // Restore original values
    Object.keys(envVars).forEach((key) => {
      if (originalValues[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValues[key];
      }
    });
  }
}

describe("AWS Credential Resolution", () => {
  describe("getGlobalAwsConfig", () => {
    test("should return empty config when no environment variables are set", () => {
      const config = withEnv(
        {
          AWS_ACCESS_KEY_ID: undefined,
          AWS_SECRET_ACCESS_KEY: undefined,
          AWS_SESSION_TOKEN: undefined,
          AWS_REGION: undefined,
          AWS_DEFAULT_REGION: undefined,
          AWS_PROFILE: undefined,
          AWS_ROLE_ARN: undefined,
          AWS_EXTERNAL_ID: undefined,
          AWS_ROLE_SESSION_NAME: undefined,
        },
        () => getGlobalAwsConfig(),
      );

      expect(config).toEqual({
        accessKeyId: undefined,
        secretAccessKey: undefined,
        sessionToken: undefined,
        region: undefined,
        profile: undefined,
        roleArn: undefined,
        externalId: undefined,
        roleSessionName: undefined,
      });
    });

    test("should read AWS credentials from environment variables", () => {
      const config = withEnv(
        {
          AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
          AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
          AWS_SESSION_TOKEN: "session-token-example",
          AWS_REGION: "us-west-2",
          AWS_PROFILE: "my-profile",
          AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/MyRole",
          AWS_EXTERNAL_ID: "unique-external-id",
          AWS_ROLE_SESSION_NAME: "my-session",
        },
        () => getGlobalAwsConfig(),
      );

      expect(config).toEqual({
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        sessionToken: "session-token-example",
        region: "us-west-2",
        profile: "my-profile",
        roleArn: "arn:aws:iam::123456789012:role/MyRole",
        externalId: "unique-external-id",
        roleSessionName: "my-session",
      });
    });

    test("should prefer AWS_REGION over AWS_DEFAULT_REGION", () => {
      const config = withEnv(
        {
          AWS_REGION: "us-west-2",
          AWS_DEFAULT_REGION: "us-east-1",
        },
        () => getGlobalAwsConfig(),
      );

      expect(config.region).toBe("us-west-2");
    });

    test("should use AWS_DEFAULT_REGION when AWS_REGION is not set", () => {
      const config = withEnv(
        {
          AWS_REGION: undefined,
          AWS_DEFAULT_REGION: "us-east-1",
        },
        () => getGlobalAwsConfig(),
      );

      expect(config.region).toBe("us-east-1");
    });
  });

  describe("resolveAwsCredentials", () => {
    test("should return global config when no scope or resource props provided", () => {
      const resolved = withEnv(
        {
          AWS_REGION: "us-west-2",
          AWS_PROFILE: "global-profile",
          AWS_ACCESS_KEY_ID: undefined,
          AWS_SECRET_ACCESS_KEY: undefined,
          AWS_SESSION_TOKEN: undefined,
          AWS_DEFAULT_REGION: undefined,
          AWS_ROLE_ARN: undefined,
          AWS_EXTERNAL_ID: undefined,
          AWS_ROLE_SESSION_NAME: undefined,
        },
        () => resolveAwsCredentials(),
      );

      expect(resolved).toEqual({
        region: "us-west-2",
        profile: "global-profile",
      });
    });

    test("should merge scope metadata with global config", () => {
      const resolved = withEnv(
        {
          AWS_REGION: "us-west-2",
          AWS_PROFILE: "global-profile",
          AWS_ACCESS_KEY_ID: undefined,
          AWS_SECRET_ACCESS_KEY: undefined,
          AWS_SESSION_TOKEN: undefined,
          AWS_DEFAULT_REGION: undefined,
          AWS_ROLE_ARN: undefined,
          AWS_EXTERNAL_ID: undefined,
          AWS_ROLE_SESSION_NAME: undefined,
        },
        () => {
          const telemetryClient = TelemetryClient.create({
            phase: "up",
            enabled: false,
            quiet: true,
          });

          const scope = new Scope({
            scopeName: "test-scope",
            parent: undefined,
            phase: "up",
            telemetryClient,
            // Scope metadata with AWS config
            awsRegion: "eu-west-1", // Should override global
            awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
          });

          return resolveAwsCredentials(undefined, scope);
        },
      );

      expect(resolved).toEqual({
        region: "eu-west-1", // From scope metadata
        profile: "global-profile", // From global env
        accessKeyId: "AKIAIOSFODNN7EXAMPLE", // From scope metadata
      });
    });

    test("should support both prefixed and non-prefixed metadata keys", () => {
      const telemetryClient = TelemetryClient.create({
        phase: "up",
        enabled: false,
        quiet: true,
      });

      const scope = new Scope({
        scopeName: "test-scope",
        parent: undefined,
        phase: "up",
        telemetryClient,
        // Mix of prefixed and non-prefixed keys
        awsRegion: "eu-west-1",
        profile: "my-profile",
        awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "secret-key",
      });

      const resolved = resolveAwsCredentials(undefined, scope);

      expect(resolved).toEqual({
        region: "eu-west-1",
        profile: "my-profile",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "secret-key",
      });
    });

    test("should prioritize resource props over scope and global config", () => {
      const resolved = withEnv(
        {
          AWS_REGION: "us-west-2",
          AWS_PROFILE: "global-profile",
          AWS_ACCESS_KEY_ID: undefined,
          AWS_SECRET_ACCESS_KEY: undefined,
          AWS_SESSION_TOKEN: undefined,
          AWS_DEFAULT_REGION: undefined,
          AWS_ROLE_ARN: undefined,
          AWS_EXTERNAL_ID: undefined,
          AWS_ROLE_SESSION_NAME: undefined,
        },
        () => {
          const telemetryClient = TelemetryClient.create({
            phase: "up",
            enabled: false,
            quiet: true,
          });

          const scope = new Scope({
            scopeName: "test-scope",
            parent: undefined,
            phase: "up",
            telemetryClient,
            awsRegion: "eu-west-1",
            awsProfile: "scope-profile",
          });

          const resourceProps: AwsClientProps = {
            region: "ap-southeast-1", // Should override both scope and global
            accessKeyId: "AKIAIOSFODNN7RESOURCE",
          };

          return resolveAwsCredentials(resourceProps, scope);
        },
      );

      expect(resolved).toEqual({
        region: "ap-southeast-1", // From resource props (highest priority)
        profile: "scope-profile", // From scope metadata
        accessKeyId: "AKIAIOSFODNN7RESOURCE", // From resource props
      });
    });

    test("should handle empty scope metadata gracefully", () => {
      const resolved = withEnv(
        {
          AWS_REGION: "us-west-2",
          AWS_PROFILE: undefined,
          AWS_ACCESS_KEY_ID: undefined,
          AWS_SECRET_ACCESS_KEY: undefined,
          AWS_SESSION_TOKEN: undefined,
          AWS_DEFAULT_REGION: undefined,
          AWS_ROLE_ARN: undefined,
          AWS_EXTERNAL_ID: undefined,
          AWS_ROLE_SESSION_NAME: undefined,
        },
        () => {
          const telemetryClient = TelemetryClient.create({
            phase: "up",
            enabled: false,
            quiet: true,
          });

          const scope = new Scope({
            scopeName: "test-scope",
            parent: undefined,
            phase: "up",
            telemetryClient,
            // No AWS-related metadata
            someOtherProperty: "value",
          });

          return resolveAwsCredentials(undefined, scope);
        },
      );

      expect(resolved).toEqual({
        region: "us-west-2", // Only global config
      });
    });

    test("should filter out undefined values from final result", () => {
      const resolved = withEnv(
        {
          AWS_REGION: "us-west-2",
          AWS_PROFILE: undefined,
          AWS_ACCESS_KEY_ID: undefined,
          AWS_SECRET_ACCESS_KEY: undefined,
          AWS_SESSION_TOKEN: undefined,
          AWS_DEFAULT_REGION: undefined,
          AWS_ROLE_ARN: undefined,
          AWS_EXTERNAL_ID: undefined,
          AWS_ROLE_SESSION_NAME: undefined,
        },
        () => resolveAwsCredentials(),
      );

      expect(resolved).toEqual({
        region: "us-west-2",
      });

      // Should not contain undefined properties
      expect(resolved).not.toHaveProperty("accessKeyId");
      expect(resolved).not.toHaveProperty("profile");
    });

    test("should throw error for invalid scope metadata", () => {
      const telemetryClient = TelemetryClient.create({
        phase: "up",
        enabled: false,
        quiet: true,
      });

      const scope = new Scope({
        scopeName: "test-scope",
        parent: undefined,
        phase: "up",
        telemetryClient,
        // Invalid AWS config - should be strings
        awsRegion: 123,
        awsProfile: true,
      });

      expect(() => resolveAwsCredentials(undefined, scope)).toThrow(
        /Invalid AWS configuration in scope metadata/,
      );
    });

    test("should throw error for invalid resource properties", () => {
      const invalidResourceProps = {
        region: 123, // Should be string
        profile: null, // Should be string
      } as any;

      expect(() => resolveAwsCredentials(invalidResourceProps)).toThrow(
        /Invalid AWS configuration in resource properties/,
      );
    });

    test("should provide helpful error messages for validation failures", () => {
      const telemetryClient = TelemetryClient.create({
        phase: "up",
        enabled: false,
        quiet: true,
      });

      const scope = new Scope({
        scopeName: "test-scope",
        parent: undefined,
        phase: "up",
        telemetryClient,
        awsRegion: 123, // Invalid type
      });

      expect(() => resolveAwsCredentials(undefined, scope)).toThrow(
        /Please ensure all AWS credential properties are strings/,
      );
    });

    test("should work without current scope", () => {
      const resolved = withEnv(
        {
          AWS_REGION: "us-west-2",
          AWS_PROFILE: undefined,
          AWS_ACCESS_KEY_ID: undefined,
          AWS_SECRET_ACCESS_KEY: undefined,
          AWS_SESSION_TOKEN: undefined,
          AWS_DEFAULT_REGION: undefined,
          AWS_ROLE_ARN: undefined,
          AWS_EXTERNAL_ID: undefined,
          AWS_ROLE_SESSION_NAME: undefined,
        },
        () => {
          const resourceProps: AwsClientProps = {
            profile: "my-profile",
          };

          return resolveAwsCredentials(resourceProps);
        },
      );

      expect(resolved).toEqual({
        region: "us-west-2",
        profile: "my-profile",
      });
    });

    test("should handle complex credential resolution scenario", () => {
      const resolved = withEnv(
        {
          AWS_REGION: "us-west-2",
          AWS_PROFILE: "global-profile",
          AWS_ACCESS_KEY_ID: "GLOBAL_ACCESS_KEY",
          AWS_SECRET_ACCESS_KEY: undefined,
          AWS_SESSION_TOKEN: undefined,
          AWS_DEFAULT_REGION: undefined,
          AWS_ROLE_ARN: undefined,
          AWS_EXTERNAL_ID: undefined,
          AWS_ROLE_SESSION_NAME: undefined,
        },
        () => {
          const telemetryClient = TelemetryClient.create({
            phase: "up",
            enabled: false,
            quiet: true,
          });

          // Scope with some overrides
          const scope = new Scope({
            scopeName: "test-scope",
            parent: undefined,
            phase: "up",
            telemetryClient,
            awsRegion: "eu-west-1", // Override global region
            awsSecretAccessKey: "SCOPE_SECRET_KEY", // Add new property
            // Keep global profile and access key
          });

          // Resource with specific overrides
          const resourceProps: AwsClientProps = {
            profile: "resource-profile", // Override scope and global
            sessionToken: "RESOURCE_SESSION_TOKEN", // Add new property
            // Keep scope region and secret, global access key
          };

          return resolveAwsCredentials(resourceProps, scope);
        },
      );

      expect(resolved).toEqual({
        region: "eu-west-1", // From scope (overrides global)
        profile: "resource-profile", // From resource (overrides scope and global)
        accessKeyId: "GLOBAL_ACCESS_KEY", // From global (not overridden)
        secretAccessKey: "SCOPE_SECRET_KEY", // From scope (not overridden)
        sessionToken: "RESOURCE_SESSION_TOKEN", // From resource (new property)
      });
    });
  });
});
