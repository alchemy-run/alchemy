import {
  isGeneratedPhysicalName,
  isGeneratedServiceAccountName,
} from "@alchemy.run/stackit/internal/names";
import { describe, expect, it } from "@alchemy.run/test";

const TAIL = "a2b3c4d5e6f7g2h3";
const HASH = "k2m3n4p5";

describe("isGeneratedPhysicalName", () => {
  it("accepts the full shape", () => {
    expect(isGeneratedPhysicalName(`mystack-assets-dev-${TAIL}`, 63)).toBe(true);
    expect(isGeneratedPhysicalName(`my-stack-assets-dev-sam-${TAIL}`, 63)).toBe(true);
  });

  it("accepts the truncated shape at exactly maxLength", () => {
    const name = `${"mystack-assets-dev-".padEnd(39, "x")}${HASH}${TAIL}`;
    expect(name.length).toBe(63);
    expect(isGeneratedPhysicalName(name, 63)).toBe(true);
  });

  it("rejects a hand-chosen name whose tail is 24 base32 characters", () => {
    expect(isGeneratedPhysicalName("customerdatabackupsstore2", 63)).toBe(false);
  });

  it("rejects a hand-chosen name with one hyphen before a 16-character tail", () => {
    expect(isGeneratedPhysicalName("acme-customerinvoice2", 63)).toBe(false);
  });

  it("rejects the full shape with too few hyphens", () => {
    expect(isGeneratedPhysicalName(`stack-dev-${TAIL}`, 63)).toBe(false);
  });

  it("rejects a tail without a base32 digit", () => {
    expect(isGeneratedPhysicalName("my-stack-assets-dev-abcdefghijklmnop", 63)).toBe(false);
  });

  it("rejects a tail with characters base32 doesn't use", () => {
    expect(isGeneratedPhysicalName("my-stack-assets-dev-a1b0c1d0e1f0g1h0", 63)).toBe(false);
  });

  it("rejects the truncated shape below maxLength", () => {
    expect(isGeneratedPhysicalName(`prefix${HASH}${TAIL}`, 63)).toBe(false);
  });

  it("rejects a name longer than maxLength", () => {
    expect(isGeneratedPhysicalName(`mystack-assets-dev-${TAIL}`, 20)).toBe(false);
  });
});

describe("isGeneratedServiceAccountName", () => {
  it("accepts a one to three character prefix", () => {
    expect(isGeneratedServiceAccountName(`sa-${TAIL}`)).toBe(true);
    expect(isGeneratedServiceAccountName(`wor-${TAIL}`)).toBe(true);
    expect(isGeneratedServiceAccountName(`a-b-${TAIL}`)).toBe(true);
  });

  it("rejects hand-chosen names", () => {
    expect(isGeneratedServiceAccountName("deploy-bot")).toBe(false);
    expect(isGeneratedServiceAccountName(`longprefix-${TAIL}`)).toBe(false);
    expect(isGeneratedServiceAccountName("sa-abcdefghijklmnop")).toBe(false);
  });
});
