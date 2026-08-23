import { toPostgresClusterSku } from "@/Planetscale";
import { describe, expect, test } from "alchemy-test";

describe("toPostgresClusterSku", () => {
  test("expands short NAS sizes with region and arch", () => {
    expect(
      toPostgresClusterSku({
        size: "PS_10",
        arch: "x86",
        region: "us-east",
      }),
    ).toBe("PS_10_AWS_X86");
    expect(
      toPostgresClusterSku({
        size: "PS_10",
        arch: "arm",
        region: "gcp-us-central1",
      }),
    ).toBe("PS_10_GCP_ARM");
  });

  test("defaults NAS expansion to AWS x86", () => {
    expect(toPostgresClusterSku({ size: "PS_10" })).toBe("PS_10_AWS_X86");
  });

  test("passes through already-suffixed NAS SKUs", () => {
    expect(toPostgresClusterSku({ size: "PS_10_AWS_X86" })).toBe(
      "PS_10_AWS_X86",
    );
    expect(toPostgresClusterSku({ size: "PS_10_GCP_ARM" })).toBe(
      "PS_10_GCP_ARM",
    );
  });

  test("normalizes hyphenated NAS sizes from PlanetScale docs", () => {
    expect(toPostgresClusterSku({ size: "PS-10", arch: "arm" })).toBe(
      "PS_10_AWS_ARM",
    );
    expect(toPostgresClusterSku({ size: "PS-10-AWS-X86" })).toBe(
      "PS_10_AWS_X86",
    );
  });

  test("passes through full Metal SKUs unchanged", () => {
    expect(toPostgresClusterSku({ size: "M1_10_AWS_ARM_D_METAL_10" })).toBe(
      "M1_10_AWS_ARM_D_METAL_10",
    );
    expect(toPostgresClusterSku({ size: "M6_640_AWS_INTEL_D_METAL_474" })).toBe(
      "M6_640_AWS_INTEL_D_METAL_474",
    );
  });

  test("normalizes hyphenated Metal SKUs from PlanetScale docs", () => {
    expect(toPostgresClusterSku({ size: "M1-10-AWS-ARM-D-METAL-10" })).toBe(
      "M1_10_AWS_ARM_D_METAL_10",
    );
    expect(toPostgresClusterSku({ size: "M6-640-AWS-INTEL-D-METAL-474" })).toBe(
      "M6_640_AWS_INTEL_D_METAL_474",
    );
  });
});
