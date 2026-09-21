import { decideStateStoreInit } from "@/Cloudflare/StateStore/State.ts";
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
