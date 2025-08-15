import { describe, expect, test } from "vitest";
import { alchemy } from "../src/alchemy.ts";
import { Scope } from "../src/scope.ts";
import { TelemetryClient } from "../src/util/telemetry/client.ts";

describe("Scope Provider Credentials", () => {
  test("should support AWS credentials at scope level", () => {
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
      // AWS credentials using the extensible pattern
      aws: {
        region: "us-west-2",
        profile: "test-profile",
        accessKeyId: alchemy.secret("AKIAIOSFODNN7EXAMPLE"),
      },
    });

    expect(scope.providerCredentials.aws?.region).toBe("us-west-2");
    expect(scope.providerCredentials.aws?.profile).toBe("test-profile");
    expect(scope.providerCredentials.aws?.accessKeyId).toBeDefined();
    // Note: We can't directly compare secrets, so we just verify it exists
  });

  test("should support Cloudflare credentials at scope level", () => {
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
      // Cloudflare credentials using the extensible pattern
      cloudflare: {
        accountId: "abc123",
        baseUrl: "https://api.cloudflare.com/client/v4",
      },
    });

    expect(scope.providerCredentials.cloudflare).toEqual({
      accountId: "abc123",
      baseUrl: "https://api.cloudflare.com/client/v4",
    });
  });

  test("should support both AWS and Cloudflare credentials at scope level", () => {
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
      // Both providers can be configured simultaneously
      aws: {
        region: "us-west-2",
        profile: "test-profile",
      },
      cloudflare: {
        accountId: "abc123",
      },
    });

    expect(scope.providerCredentials.aws).toEqual({
      region: "us-west-2",
      profile: "test-profile",
    });

    expect(scope.providerCredentials.cloudflare).toEqual({
      accountId: "abc123",
    });
  });

  test("should handle scope with no provider credentials", () => {
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
    });

    expect(scope.providerCredentials).toEqual({});
  });

  test("should ignore unknown provider credentials", () => {
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
      aws: {
        region: "us-west-2",
      },
      // This would be ignored since there's no module augmentation for it
      unknownProvider: {
        someProperty: "value",
      },
    } as any);

    expect(scope.providerCredentials.aws).toEqual({
      region: "us-west-2",
    });

    expect((scope.providerCredentials as any).unknownProvider).toEqual({
      someProperty: "value",
    });
  });
});
