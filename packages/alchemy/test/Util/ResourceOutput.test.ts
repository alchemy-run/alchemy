import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "@alchemy.run/test";
import { formatResourceTag, stripChildEffectPrefix } from "@/Util/ResourceOutput.ts";
import { theme } from "@/Util/Theme.ts";

describe("stripChildEffectPrefix", { tags: ["unit", "local"] }, () => {
  it("removes an Effect pretty prefix", () => {
    expect(
      stripChildEffectPrefix("[14:49:25.594] INFO (#1836): Cloudflare Worker reconcile: starting"),
    ).toBe("Cloudflare Worker reconcile: starting");
  });

  it("removes a colored prefix without stripping message color", () => {
    expect(
      stripChildEffectPrefix(
        "\x1b[37m[14:49:25.594]\x1b[0m \x1b[32mINFO\x1b[0m (#1836): \x1b[36mmessage\x1b[0m",
      ),
    ).toBe("\x1b[36mmessage\x1b[0m");
  });

  it("leaves ordinary child output unchanged", () => {
    expect(stripChildEffectPrefix("vite building for production...")).toBe(
      "vite building for production...",
    );
  });
});

describe("formatResourceTag", { tags: ["unit", "local"] }, () => {
  it("uses the Sigil info color when colors are enabled", () => {
    const tag = formatResourceTag("Site/Worker", true);
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(theme.color.info.slice(i, i + 2), 16));
    // Assert the color and the visible text, not which reset code closes it.
    expect(tag.startsWith(`\x1b[38;2;${r};${g};${b}m`)).toBe(true);
    expect(stripVTControlCharacters(tag)).toBe("[Site/Worker]");
  });

  it("stays parseable when colors are disabled", () => {
    expect(formatResourceTag("Site/Worker", false)).toBe("[Site/Worker]");
  });
});
