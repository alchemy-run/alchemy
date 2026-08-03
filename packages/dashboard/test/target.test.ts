/**
 * The `(stack, stage)` URL contract: a hosted-viewer link must survive a
 * reload and a paste into someone else's browser, which means whatever
 * the picker selects has to round-trip through the address bar.
 */
import { afterEach, expect, test } from "bun:test";
import { targetFromLocation, writeTargetToLocation } from "../src/target.ts";

/** Minimal `window` — target.ts only reads `location` and `history`. */
const stubWindow = (url: string): { href: () => string } => {
  const parsed = new URL(url);
  const win = {
    location: {
      get search() {
        return parsed.search;
      },
      get pathname() {
        return parsed.pathname;
      },
      get hash() {
        return parsed.hash;
      },
    },
    history: {
      replaceState: (_state: unknown, _title: string, next: string) => {
        const resolved = new URL(next, parsed.origin);
        parsed.search = resolved.search;
        parsed.pathname = resolved.pathname;
        parsed.hash = resolved.hash;
      },
    },
  };
  (globalThis as { window?: unknown }).window = win;
  return { href: () => `${parsed.pathname}${parsed.search}${parsed.hash}` };
};

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

test("a bare path means 'let the server choose' on both axes", () => {
  stubWindow("https://viewer.example/");
  expect(targetFromLocation()).toEqual({ stack: undefined, stage: undefined });
});

test("reads both axes, and treats blanks as unset", () => {
  stubWindow("https://viewer.example/?stack=f311x&stage=prod");
  expect(targetFromLocation()).toEqual({ stack: "f311x", stage: "prod" });

  stubWindow("https://viewer.example/?stack=&stage=prod");
  expect(targetFromLocation()).toEqual({ stack: undefined, stage: "prod" });
});

test("a written target round-trips back out", () => {
  const win = stubWindow("https://viewer.example/");
  writeTargetToLocation({ stack: "f311x", stage: "prod" });
  expect(win.href()).toBe("/?stack=f311x&stage=prod");
  expect(targetFromLocation()).toEqual({ stack: "f311x", stage: "prod" });
});

test("clearing an axis drops it from the URL instead of blanking it", () => {
  const win = stubWindow("https://viewer.example/?stack=f311x&stage=prod");
  writeTargetToLocation({ stack: "f311x", stage: undefined });
  expect(win.href()).toBe("/?stack=f311x");
  expect(targetFromLocation()).toEqual({ stack: "f311x", stage: undefined });
});

test("unrelated query params and the hash survive a target write", () => {
  const win = stubWindow("https://viewer.example/?theme=dark#node-abc");
  writeTargetToLocation({ stack: "github", stage: "dev" });
  expect(win.href()).toBe("/?theme=dark&stack=github&stage=dev#node-abc");
});

test("values needing encoding survive the round trip", () => {
  const win = stubWindow("https://viewer.example/");
  writeTargetToLocation({ stack: "my stack", stage: "dev/davidfelix" });
  expect(win.href()).toContain("stack=my+stack");
  expect(targetFromLocation()).toEqual({
    stack: "my stack",
    stage: "dev/davidfelix",
  });
});
