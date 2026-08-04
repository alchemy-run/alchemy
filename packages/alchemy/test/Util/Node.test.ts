import { isTransformTypesSupported } from "@/Util/Node";
import { describe, expect, test } from "alchemy-test";

describe("Node utilities", () => {
  test("detects versions that support --experimental-transform-types", () => {
    expect(isTransformTypesSupported("22.6.0")).toBe(false);
    expect(isTransformTypesSupported("22.7.0")).toBe(true);
    expect(isTransformTypesSupported("25.9.0")).toBe(true);
    expect(isTransformTypesSupported("26.0.0")).toBe(false);
  });
});
