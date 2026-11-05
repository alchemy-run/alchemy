import { describe, expect, test } from "@alchemy.run/test";
import { formatElapsed } from "@/Cli/Format.ts";

describe("formatElapsed", { tags: ["unit", "local"] }, () => {
  test("uses milliseconds under a second", () => {
    expect(formatElapsed(-5)).toBe("0ms");
    expect(formatElapsed(0)).toBe("0ms");
    expect(formatElapsed(450)).toBe("450ms");
  });

  test("uses tenths of a second under a minute", () => {
    expect(formatElapsed(1000)).toBe("1.0s");
    expect(formatElapsed(42_700)).toBe("42.7s");
    expect(formatElapsed(59_949)).toBe("59.9s");
  });

  test("uses minutes and seconds under an hour", () => {
    expect(formatElapsed(59_950)).toBe("1m 0s");
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(754_300)).toBe("12m 34s");
  });

  test("uses hours from an hour up", () => {
    expect(formatElapsed(3_599_600)).toBe("1h 0m 0s");
    expect(formatElapsed(3_723_000)).toBe("1h 2m 3s");
  });
});
