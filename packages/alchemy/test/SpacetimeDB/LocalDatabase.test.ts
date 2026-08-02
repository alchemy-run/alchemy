import { describe, expect, test } from "alchemy-test";
import { shellQuote } from "@/SpacetimeDB/LocalDatabase.ts";

describe("shellQuote", () => {
  test("passes through safe characters", () => {
    expect(shellQuote("my-game")).toBe("my-game");
    expect(shellQuote("./path/to/file.ts")).toBe("./path/to/file.ts");
    expect(shellQuote("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(shellQuote("--flag=value")).toBe("--flag=value");
  });

  test("wraps empty string", () => {
    expect(shellQuote("")).toBe("''");
  });

  test("single-quotes strings with spaces", () => {
    expect(shellQuote("a b c")).toBe("'a b c'");
  });

  test("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
