import { describe, expect, test } from "vitest";
import {
  getGlobalAwsConfig,
  resolveAwsCredentials,
} from "../../src/aws/credentials.ts";
import { Scope } from "../../src/scope.ts";
import { TelemetryClient } from "../../src/util/telemetry/client.ts";

// Helper function to temporarily set environment variables for a test
async function withEnv<T>(
  envVars: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
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
    return await fn();
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
    test("should return empty config when no environment variables are set", async () => {
      const config = await withEnv(
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

      expect(config).toEqual({});
    });

    test("should read AWS credentials from environment variables", async () => {
      const config = await withEnv(
        {
          AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
          AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
          AWS_SESSION_TOKEN: "session-token",
          AWS_REGION: "us-west-2",
          AWS_PROFILE: "test-profile",
          AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/TestRole",
          AWS_EXTERNAL_ID: "external-id",
          AWS_ROLE_SESSION_NAME: "test-session",
        },
        () => getGlobalAwsConfig(),
      );

      expect(config).toEqual({
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        sessionToken: "session-token",
        region: "us-west-2",
        profile: "test-profile",
        roleArn: "arn:aws:iam::123456789012:role/TestRole",
        externalId: "external-id",
        roleSessionName: "test-session",
      });
    });

    test("should prefer AWS_REGION over AWS_DEFAULT_REGION", async () => {
      const config = await withEnv(
        {
          AWS_REGION: "us-east-1",
          AWS_DEFAULT_REGION: "us-west-2",
        },
        () => getGlobalAwsConfig(),
      );

      expect(config.region).toBe("us-east-1");
    });

    test("should use AWS_DEFAULT_REGION when AWS_REGION is not set", async () => {
      const config = await withEnv(
        {
          AWS_REGION: undefined,
          AWS_DEFAULT_REGION: "us-west-2",
        },
        () => getGlobalAwsConfig(),
      );

      expect(config.region).toBe("us-west-2");
    });
  });

  describe("resolveAwsCredentials", () => {
    test("should return global config when no resource props provided", async () => {
      const resolved = await withEnv(
        {
          AWS_REGION: "us-west-2",
          AWS_PROFILE: "global-profile",
        },
        () => resolveAwsCredentials(),
      );

      expect(resolved).toEqual({
        region: "us-west-2",
        profile: "global-profile",
      });
    });

    test("should merge scope credentials with global config", async () => {
      const resolved = await withEnv(
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
        async () => {
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
            // Scope-level AWS credential overrides
            aws: {
              region: "eu-west-1", // Should override global
              accessKeyId: "AKIAIOSFODNN7EXAMPLE",
            },
          });

          return await scope.run(async () => resolveAwsCredentials());
        },
      );

      expect(resolved).toEqual({
        region: "eu-west-1", // From scope
        profile: "global-profile", // From global env
        accessKeyId: "AKIAIOSFODNN7EXAMPLE", // From scope
      });
    });

    test("should prioritize resource props over scope and global config", async () => {
      const resolved = await withEnv(
        {
          AWS_REGION: "us-west-2",
          AWS_PROFILE: "global-profile",
          AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7GLOBAL",
          AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYGLOBAL",
        },
        async () => {
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
            // Scope-level AWS credential overrides
            aws: {
              region: "eu-central-1",
              profile: "scope-profile",
            },
          });

          return await scope.run(async () =>
            resolveAwsCredentials({
              region: "ap-southeast-1",
              accessKeyId: "AKIAIOSFODNN7RESOURCE",
            }),
          );
        },
      );

      expect(resolved).toEqual({
        region: "ap-southeast-1", // From resource props (highest priority)
        profile: "scope-profile", // From scope
        accessKeyId: "AKIAIOSFODNN7RESOURCE", // From resource props
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYGLOBAL", // From global env
      });
    });

    test("should filter out undefined values from final result", async () => {
      const resolved = await withEnv(
        {
          AWS_REGION: "us-west-2",
          AWS_PROFILE: undefined,
          AWS_ACCESS_KEY_ID: undefined,
        },
        () =>
          resolveAwsCredentials({
            profile: "resource-profile",
          }),
      );

      expect(resolved).toEqual({
        region: "us-west-2",
        profile: "resource-profile",
      });
    });

    test("should throw error for invalid resource properties", async () => {
      await expect(
        async () =>
          await resolveAwsCredentials({
            region: 123 as any, // Invalid type
          }),
      ).rejects.toThrow(
        /Invalid AWS configuration in resource properties.*Property 'region' must be a string/,
      );
    });

    test("should provide helpful error messages for validation failures", async () => {
      await expect(
        async () =>
          await resolveAwsCredentials({
            region: 123 as any,
            profile: true as any,
          }),
      ).rejects.toThrow(
        /Invalid AWS configuration in resource properties.*Property 'region' must be a string/,
      );
    });

    test("should handle complex credential resolution scenario", async () => {
      const resolved = await withEnv(
        {
          AWS_REGION: "us-west-2",
          AWS_PROFILE: "global-profile",
          AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7GLOBAL",
          AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYGLOBAL",
          AWS_SESSION_TOKEN: "global-session-token",
          AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/GlobalRole",
        },
        () =>
          resolveAwsCredentials({
            region: "eu-central-1",
            profile: "resource-profile",
            accessKeyId: "AKIAIOSFODNN7RESOURCE",
            // secretAccessKey and sessionToken should come from global
            roleArn: "arn:aws:iam::987654321098:role/ResourceRole",
          }),
      );

      expect(resolved).toEqual({
        region: "eu-central-1", // Resource override
        profile: "resource-profile", // Resource override
        accessKeyId: "AKIAIOSFODNN7RESOURCE", // Resource override
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYGLOBAL", // Global
        sessionToken: "global-session-token", // Global
        roleArn: "arn:aws:iam::987654321098:role/ResourceRole", // Resource override
      });
    });
  });
});
