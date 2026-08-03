/**
 * The URL contract. A viewer link must survive a reload and a paste into
 * someone else's browser, and links minted before paths existed
 * (`?stack=&stage=`) must keep resolving.
 */
import { afterEach, expect, test } from "bun:test";
import {
  navigate,
  parseRoute,
  pathOf,
  replaceRoute,
  subscribeRoute,
} from "../src/route.ts";

/** Minimal `window` — route.ts only touches `location` and `history`. */
const stubWindow = (url: string): { href: () => string } => {
  const parsed = new URL(url);
  const apply = (next: string) => {
    const resolved = new URL(next, parsed.origin);
    parsed.pathname = resolved.pathname;
    parsed.search = resolved.search;
    parsed.hash = resolved.hash;
  };
  (globalThis as { window?: unknown }).window = {
    location: {
      get pathname() {
        return parsed.pathname;
      },
      get search() {
        return parsed.search;
      },
      get hash() {
        return parsed.hash;
      },
    },
    history: {
      pushState: (_s: unknown, _t: string, next: string) => apply(next),
      replaceState: (_s: unknown, _t: string, next: string) => apply(next),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { href: () => `${parsed.pathname}${parsed.search}` };
};

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

test("/ is the index", () => {
  expect(parseRoute("/")).toEqual({ kind: "index" });
});

test("/stacks/:stack targets a stack with the server's default stage", () => {
  expect(parseRoute("/stacks/f311x")).toEqual({
    kind: "target",
    stack: "f311x",
    stage: undefined,
  });
});

test("/stacks/:stack/:stage targets both", () => {
  expect(parseRoute("/stacks/f311x/prod")).toEqual({
    kind: "target",
    stack: "f311x",
    stage: "prod",
  });
});

test("segments are decoded, so names with reserved characters survive", () => {
  const path = pathOf({ stack: "my stack", stage: "dev/felix" });
  expect(path).toBe("/stacks/my%20stack/dev%2Ffelix");
  expect(parseRoute(path)).toEqual({
    kind: "target",
    stack: "my stack",
    stage: "dev/felix",
  });
});

test("legacy ?stack=&stage= links still resolve to a target", () => {
  expect(parseRoute("/", "?stack=f311x&stage=prod")).toEqual({
    kind: "target",
    stack: "f311x",
    stage: "prod",
  });
});

test("a blank legacy stack is not a target", () => {
  expect(parseRoute("/", "?stack=")).toEqual({ kind: "index" });
});

test("trailing slashes and extra segments do not confuse the match", () => {
  expect(parseRoute("/stacks/f311x/")).toEqual({
    kind: "target",
    stack: "f311x",
    stage: undefined,
  });
});

test("navigate pushes the path and notifies subscribers", () => {
  const win = stubWindow("https://viewer.example/");
  let notified = 0;
  const unsubscribe = subscribeRoute(() => {
    notified += 1;
  });
  navigate(pathOf({ stack: "github", stage: "dev" }));
  expect(win.href()).toBe("/stacks/github/dev");
  expect(notified).toBe(1);
  unsubscribe();
});

test("navigating to where you already are is a no-op", () => {
  stubWindow("https://viewer.example/stacks/github/dev");
  let notified = 0;
  const unsubscribe = subscribeRoute(() => {
    notified += 1;
  });
  navigate("/stacks/github/dev");
  expect(notified).toBe(0);
  unsubscribe();
});

test("replaceRoute canonicalizes a legacy link in place", () => {
  const win = stubWindow("https://viewer.example/?stack=f311x&stage=prod");
  const route = parseRoute(
    (globalThis as { window: { location: { pathname: string } } }).window
      .location.pathname,
    "?stack=f311x&stage=prod",
  );
  expect(route.kind).toBe("target");
  if (route.kind === "target") {
    replaceRoute(pathOf(route));
  }
  expect(win.href()).toBe("/stacks/f311x/prod");
});
