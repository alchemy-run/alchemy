import { describe, expect, test } from "vitest";
import { Scope } from "../src/scope.ts";
import { TelemetryClient } from "../src/util/telemetry/client.ts";

describe("Scope Metadata Storage", () => {
  test("should store arbitrary metadata properties", () => {
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
      // Arbitrary metadata properties
      awsRegion: "us-west-2",
      awsProfile: "test-profile",
      customConfig: { nested: { value: 42 } },
      stringValue: "test-string",
      numberValue: 123,
      booleanValue: true,
      arrayValue: [1, 2, 3],
    });

    expect(scope.metadata).toEqual({
      awsRegion: "us-west-2",
      awsProfile: "test-profile",
      customConfig: { nested: { value: 42 } },
      stringValue: "test-string",
      numberValue: 123,
      booleanValue: true,
      arrayValue: [1, 2, 3],
    });
  });

  test("should not include known properties in metadata", () => {
    const telemetryClient = TelemetryClient.create({
      phase: "up",
      enabled: false,
      quiet: true,
    });

    const scope = new Scope({
      scopeName: "test-scope",
      parent: undefined,
      phase: "up",
      stage: "test-stage",
      quiet: true,
      password: "test-password",
      telemetryClient,
      // Arbitrary metadata properties
      awsRegion: "us-west-2",
      customValue: "should-be-in-metadata",
    });

    // Known properties should not be in metadata
    expect(scope.metadata).not.toHaveProperty("scopeName");
    expect(scope.metadata).not.toHaveProperty("parent");
    expect(scope.metadata).not.toHaveProperty("phase");
    expect(scope.metadata).not.toHaveProperty("stage");
    expect(scope.metadata).not.toHaveProperty("quiet");
    expect(scope.metadata).not.toHaveProperty("password");
    expect(scope.metadata).not.toHaveProperty("telemetryClient");

    // Only arbitrary properties should be in metadata
    expect(scope.metadata).toEqual({
      awsRegion: "us-west-2",
      customValue: "should-be-in-metadata",
    });
  });

  test("should handle empty metadata", () => {
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

    expect(scope.metadata).toEqual({});
  });

  test("should handle various data types in metadata", () => {
    const telemetryClient = TelemetryClient.create({
      phase: "up",
      enabled: false,
      quiet: true,
    });

    const testDate = new Date("2023-01-01");
    const testRegex = /test-pattern/;
    const testFunction = () => "test";

    const scope = new Scope({
      scopeName: "test-scope",
      parent: undefined,
      phase: "up",
      telemetryClient,
      // Various data types
      stringValue: "test",
      numberValue: 42,
      booleanValue: true,
      nullValue: null,
      undefinedValue: undefined,
      arrayValue: [1, "two", { three: 3 }],
      objectValue: { nested: { deep: "value" } },
      dateValue: testDate,
      regexValue: testRegex,
      functionValue: testFunction,
    });

    expect(scope.metadata.stringValue).toBe("test");
    expect(scope.metadata.numberValue).toBe(42);
    expect(scope.metadata.booleanValue).toBe(true);
    expect(scope.metadata.nullValue).toBe(null);
    expect(scope.metadata.undefinedValue).toBe(undefined);
    expect(scope.metadata.arrayValue).toEqual([1, "two", { three: 3 }]);
    expect(scope.metadata.objectValue).toEqual({ nested: { deep: "value" } });
    expect(scope.metadata.dateValue).toBe(testDate);
    expect(scope.metadata.regexValue).toBe(testRegex);
    expect(scope.metadata.functionValue).toBe(testFunction);
  });

  test("should handle nested objects in metadata", () => {
    const telemetryClient = TelemetryClient.create({
      phase: "up",
      enabled: false,
      quiet: true,
    });

    const complexMetadata = {
      aws: {
        region: "us-west-2",
        profile: "test-profile",
        credentials: {
          accessKeyId: "test-key",
          secretAccessKey: "test-secret",
        },
      },
      database: {
        host: "localhost",
        port: 5432,
        ssl: true,
      },
    };

    const scope = new Scope({
      scopeName: "test-scope",
      parent: undefined,
      phase: "up",
      telemetryClient,
      ...complexMetadata,
    });

    expect(scope.metadata).toEqual(complexMetadata);
    expect(scope.metadata.aws.region).toBe("us-west-2");
    expect(scope.metadata.aws.credentials.accessKeyId).toBe("test-key");
    expect(scope.metadata.database.port).toBe(5432);
  });
});
