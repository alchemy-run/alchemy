import { describe, expect, it } from "alchemy-test";
import { makeLineBuffer } from "@/Util/LineBuffer.ts";

describe("makeLineBuffer", { tags: ["unit", "local"] }, () => {
  it("preserves CRLF lines at every chunk boundary", () => {
    const text = "ready\r\n\r\nnext\r\npartial";
    for (let split = 0; split <= text.length; split++) {
      const lines: string[] = [];
      const buffer = makeLineBuffer((line) => lines.push(line));
      buffer.push(text.slice(0, split));
      buffer.push(text.slice(split));
      expect(lines).toEqual(["ready", "", "next"]);
      buffer.flush();
      buffer.flush();
      expect(lines).toEqual(["ready", "", "next", "partial"]);
    }
  });

  it("joins repeated split CRLF endings across empty chunks", () => {
    const lines: string[] = [];
    const buffer = makeLineBuffer((line) => lines.push(line));
    for (const chunk of ["ready\r", "", "", "\nnext\r", "", "\n"]) {
      buffer.push(chunk);
    }
    buffer.flush();
    expect(lines).toEqual(["ready", "next"]);
  });

  it("emits LF and bare CR immediately and preserves blank lines", () => {
    const lines: string[] = [];
    const buffer = makeLineBuffer((line) => lines.push(line));
    buffer.push("\nready\r");
    expect(lines).toEqual(["", "ready"]);
    buffer.push("");
    buffer.push("\rnext\n\ntail");
    expect(lines).toEqual(["", "ready", "", "next", ""]);
    buffer.flush();
    expect(lines).toEqual(["", "ready", "", "next", "", "tail"]);
  });

  it("flushes once and resets line-ending state for reuse", () => {
    const lines: string[] = [];
    const buffer = makeLineBuffer((line) => lines.push(line));
    buffer.flush();
    expect(lines).toEqual([]);
    buffer.push("ready\r");
    buffer.flush();
    buffer.flush();
    expect(lines).toEqual(["ready"]);
    buffer.push("\nnext");
    expect(lines).toEqual(["ready", ""]);
    buffer.flush();
    buffer.flush();
    expect(lines).toEqual(["ready", "", "next"]);
  });
});
