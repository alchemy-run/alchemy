import {
  decideStateStoreInit,
  isSubdomainAbsence,
  shouldRefuseFreshBootstrap,
} from "@/Cloudflare/StateStore/State.ts";
import { describe, expect, it } from "alchemy-test";

describe("decideStateStoreInit", () => {
  const cases: ReadonlyArray<{
    serving: boolean;
    autoUpdate: boolean;
    isCI: boolean;
    expected: ReturnType<typeof decideStateStoreInit>;
  }> = [
    { serving: true, autoUpdate: true, isCI: true, expected: "login" },
    { serving: true, autoUpdate: true, isCI: false, expected: "login" },
    { serving: true, autoUpdate: false, isCI: true, expected: "login" },
    { serving: true, autoUpdate: false, isCI: false, expected: "login" },
    { serving: false, autoUpdate: true, isCI: true, expected: "refuse-ci" },
    { serving: false, autoUpdate: false, isCI: true, expected: "refuse-ci" },
    { serving: false, autoUpdate: true, isCI: false, expected: "bootstrap" },
    { serving: false, autoUpdate: false, isCI: false, expected: "prompt" },
  ];

  for (const { expected, ...input } of cases) {
    it(`${JSON.stringify(input)} -> ${expected}`, () => {
      expect(decideStateStoreInit(input)).toBe(expected);
    });
  }

  it("never bootstraps in CI, even with --yes", () => {
    expect(
      decideStateStoreInit({ serving: false, autoUpdate: true, isCI: true }),
    ).toBe("refuse-ci");
  });
});

describe("isSubdomainAbsence", () => {
  it("treats a missing subdomain or route as absent", () => {
    expect(isSubdomainAbsence({ _tag: "SubdomainNotFound" })).toBe(true);
    expect(isSubdomainAbsence({ _tag: "InvalidRoute" })).toBe(true);
  });

  it("treats a permission failure as unknown", () => {
    expect(isSubdomainAbsence({ _tag: "Forbidden" })).toBe(false);
    expect(isSubdomainAbsence({ _tag: "Unauthorized" })).toBe(false);
    expect(isSubdomainAbsence({ _tag: "HttpClientError" })).toBe(false);
  });
});

describe("shouldRefuseFreshBootstrap", () => {
  const existingNames = [
    "AlchemyStateStoreToken",
    "AlchemyStateStoreEncryptionKey",
  ];

  it("refuses a fresh bootstrap when the secrets already exist", () => {
    expect(
      shouldRefuseFreshBootstrap({
        hasLocalRandoms: false,
        force: false,
        existingNames,
      }),
    ).toBe(true);
  });

  it("allows --force", () => {
    expect(
      shouldRefuseFreshBootstrap({
        hasLocalRandoms: false,
        force: true,
        existingNames,
      }),
    ).toBe(false);
  });

  it("allows a resume when the local stack holds both random values", () => {
    expect(
      shouldRefuseFreshBootstrap({
        hasLocalRandoms: true,
        force: false,
        existingNames,
      }),
    ).toBe(false);
  });

  it("allows a fresh bootstrap when no secrets exist", () => {
    expect(
      shouldRefuseFreshBootstrap({
        hasLocalRandoms: false,
        force: false,
        existingNames: [],
      }),
    ).toBe(false);
  });
});
