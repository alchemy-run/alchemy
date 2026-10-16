import { normalizeName, normalizeType } from "@/Vercel/DNS/Record.ts";
import { describe, expect, test } from "alchemy-test";

describe("vercel dns normalize helpers", { tags: ["unit", "local"] }, () => {
  test("lowercases names and strips a trailing dot", () => {
    expect(normalizeName("Preview.EXAMPLE.com.")).toBe("preview.example.com");
    expect(normalizeName("")).toBe("");
  });

  test("uppercases record types", () => {
    expect(normalizeType("cname")).toBe("CNAME");
    expect(normalizeType("TXT")).toBe("TXT");
  });
});
