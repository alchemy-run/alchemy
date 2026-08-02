import {
  clearDataFlag,
  localDevArgs,
  parseCliVersion,
  scrapeIdentity,
} from "@/SpacetimeDB/Cli.ts";
import { describe, expect, test } from "alchemy-test";

describe("clearDataFlag", () => {
  test("maps boolean and enum forms", () => {
    expect(clearDataFlag(undefined)).toBeUndefined();
    expect(clearDataFlag(false)).toBeUndefined();
    expect(clearDataFlag("never")).toBeUndefined();
    expect(clearDataFlag(true)).toBe("always");
    expect(clearDataFlag("always")).toBe("always");
    expect(clearDataFlag("on-conflict")).toBe("on-conflict");
  });
});

describe("scrapeIdentity", () => {
  test("reads labeled identity lines", () => {
    expect(
      scrapeIdentity("Created database\nIdentity: deadbeefcafebabe01234567"),
    ).toBe("deadbeefcafebabe01234567");
    expect(
      scrapeIdentity("database_identity: abcdef0123456789abcdef0123456789"),
    ).toBe("abcdef0123456789abcdef0123456789");
  });

  test("falls back to a long hex token", () => {
    expect(scrapeIdentity("ok 0123456789abcdef0123456789abcdef done")).toBe(
      "0123456789abcdef0123456789abcdef",
    );
  });

  test("returns undefined when nothing matches", () => {
    expect(scrapeIdentity("published successfully")).toBeUndefined();
  });
});

describe("localDevArgs", () => {
  test("builds spacetime dev --server-only argv", () => {
    expect(
      localDevArgs({
        database: "my-game",
        modulePath: "./spacetimedb",
      }),
    ).toEqual([
      "dev",
      "my-game",
      "--server",
      "local",
      "--server-only",
      "--yes",
      "--module-path",
      "./spacetimedb",
    ]);
  });

  test("forwards clearData always", () => {
    const args = localDevArgs({
      database: "db",
      binPath: "./m.wasm",
      clearData: true,
    });
    expect(args).toContain("--delete-data");
    expect(args).toContain("always");
    expect(args).toContain("--bin-path");
  });
});

describe("parseCliVersion", () => {
  test("extracts semver from CLI banner", () => {
    expect(
      parseCliVersion(
        "spacetimedb tool version 2.7.1; spacetimedb-lib version 2.7.1;",
      ),
    ).toBe("2.7.1");
  });

  test("returns undefined on unrecognized output", () => {
    expect(parseCliVersion("something else entirely")).toBeUndefined();
  });

  test("handles pre-release versions", () => {
    expect(parseCliVersion("spacetimedb tool version 2.7.0-rc1;")).toBe(
      "2.7.0-rc1",
    );
  });
});
