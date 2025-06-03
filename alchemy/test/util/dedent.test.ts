import { describe, expect, it } from "vitest";
import { dedent } from "../../src/util/dedent.ts";

describe("dedent", () => {
  it("removes common indentation", () => {
    const s = dedent`
      line1
        line2
      line3
    `;
    expect(s).toBe("line1\n  line2\nline3");
  });

  it("removes leading and trailing blank lines", () => {
    const s = dedent`

      line1
      line2

    `;
    expect(s).toBe("line1\nline2");
  });

  it("preserves extra indentation", () => {
    const s = dedent`
      level1
        level2
          level3
    `;
    expect(s).toBe("level1\n  level2\n    level3");
  });

  it("handles empty template", () => {
    const s = dedent``;
    expect(s).toBe("");
  });

  it("handles single line", () => {
    const s = dedent`single line`;
    expect(s).toBe("single line");
  });

  it("interpolates values correctly", () => {
    const value = "world";
    const s = dedent`
      hello ${value}
      bye
    `;
    expect(s).toBe("hello world\nbye");
  });

  it("preserves blank lines in between", () => {
    const s = dedent`
      line1

      line3
    `;
    expect(s).toBe("line1\n\nline3");
  });

  it("returns empty for only whitespace lines", () => {
    const s = dedent`
      
         
      `;
    expect(s).toBe("");
  });
});
