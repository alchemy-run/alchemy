import { describe, expect, test } from "vitest";

import { _internal } from "../../src/Cli/checkVersion";

const { compareVersions, pickDistTag } = _internal;

describe("compareVersions", () => {
  test("equal versions", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  test("major/minor/patch ordering", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareVersions("1.3.0", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });

  test("prerelease is lower precedence than release with same core", () => {
    expect(compareVersions("2.0.0-beta.33", "2.0.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "2.0.0-beta.33")).toBeGreaterThan(0);
  });

  test("ordering between same-channel betas is numeric", () => {
    expect(compareVersions("2.0.0-beta.9", "2.0.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("2.0.0-beta.33", "2.0.0-beta.32")).toBeGreaterThan(
      0,
    );
    expect(compareVersions("2.0.0-beta.33", "2.0.0-beta.33")).toBe(0);
  });

  test("released stable on different core dominates beta", () => {
    expect(compareVersions("2.0.0-beta.33", "2.1.0")).toBeLessThan(0);
    expect(compareVersions("2.1.0", "2.0.0-beta.33")).toBeGreaterThan(0);
  });
});

describe("pickDistTag", () => {
  // Real shape returned by https://registry.npmjs.org/-/package/alchemy/dist-tags
  const realDistTags = { latest: "0.93.7", next: "2.0.0-beta.33" };

  test("beta version picks the matching prerelease tag (next) over latest", () => {
    expect(pickDistTag("2.0.0-beta.30", realDistTags)).toBe("2.0.0-beta.33");
  });

  test("stable version picks latest", () => {
    expect(pickDistTag("0.93.6", realDistTags)).toBe("0.93.7");
  });

  test("prefers identifier-named tag when present", () => {
    expect(
      pickDistTag("2.0.0-beta.30", {
        latest: "0.93.7",
        next: "2.0.0-rc.1",
        beta: "2.0.0-beta.40",
      }),
    ).toBe("2.0.0-beta.40");
  });

  test("falls back to next when no identifier-named tag exists", () => {
    expect(
      pickDistTag("2.0.0-rc.1", { latest: "0.93.7", next: "2.0.0-rc.2" }),
    ).toBe("2.0.0-rc.2");
  });

  test("falls back to latest when no prerelease channel exists", () => {
    expect(pickDistTag("2.0.0-beta.30", { latest: "0.93.7" })).toBe("0.93.7");
  });
});
