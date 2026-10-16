import { describe, expect, it } from "vitest";
import { normalizeName, normalizeType } from "@/Vercel/DNS/Record.ts";

describe("normalize helpers (no credentials needed)", () => {
  it("lowercases names and strips a trailing dot", () => {
    expect(normalizeName("Preview.EXAMPLE.com.")).toBe("preview.example.com");
    expect(normalizeName("")).toBe("");
  });

  it("uppercases record types", () => {
    expect(normalizeType("cname")).toBe("CNAME");
    expect(normalizeType("TXT")).toBe("TXT");
  });
});
