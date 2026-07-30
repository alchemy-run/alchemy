import { describe, expect, test } from "bun:test";
import {
  collectorExtensionLayerArn,
  collectorLayerVersion,
  collectorRelease,
} from "../src/Collector.ts";

describe("collector extension layer ARN", () => {
  test("maps Lambda x86_64 to the upstream amd64 layer", () => {
    expect(
      collectorExtensionLayerArn({
        region: "us-east-1",
        architecture: "x86_64",
      }),
    ).toBe(
      `arn:aws:lambda:us-east-1:184161586896:layer:opentelemetry-collector-amd64-${collectorRelease}:${collectorLayerVersion}`,
    );
  });

  test("preserves arm64 and the selected Region", () => {
    expect(
      collectorExtensionLayerArn({
        region: "eu-west-1",
        architecture: "arm64",
      }),
    ).toBe(
      `arn:aws:lambda:eu-west-1:184161586896:layer:opentelemetry-collector-arm64-${collectorRelease}:${collectorLayerVersion}`,
    );
  });
});
