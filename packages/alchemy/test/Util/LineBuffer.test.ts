import { describe, expect, it } from "@alchemy.run/test";
import { makeLineBuffer } from "@/Util/LineBuffer.ts";

const linesOf = (chunks: ReadonlyArray<string>) => {
  const lines: string[] = [];
  const buffer = makeLineBuffer((line) => lines.push(line));
  for (const chunk of chunks) buffer.push(chunk);
  buffer.flush();
  return lines;
};

describe("makeLineBuffer", { tags: ["unit", "local"] }, () => {
  it("splits on \\n, \\r\\n and \\r across chunk boundaries", () => {
    expect(linesOf(["a\nb", "c\r", "\nd\re", "\r\n", "", "tail"])).toEqual([
      "a",
      "bc",
      "d",
      "e",
      "tail",
    ]);
    expect(linesOf(["one\n", "\n", "two"])).toEqual(["one", "", "two"]);
    expect(linesOf(["done\n"])).toEqual(["done"]);
  });

  it("buffers a long line arriving in small chunks in linear time", () => {
    const chunk = "x".repeat(64);
    const count = (2 * 1024 * 1024) / chunk.length;
    const lines: string[] = [];
    const buffer = makeLineBuffer((line) => lines.push(line));
    const start = performance.now();
    for (let i = 0; i < count; i++) buffer.push(chunk);
    buffer.push("\n");
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(2 * 1024 * 1024);
  });
});
