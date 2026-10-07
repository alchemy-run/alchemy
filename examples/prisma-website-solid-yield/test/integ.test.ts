import { expect } from "bun:test";
import * as Alchemy from "alchemy";
import * as Prisma from "alchemy/Prisma";
import * as Test from "alchemy/Test/Bun";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { getWhenReady } = Test;

class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  body: string;
}> {}

// Fresh Compute URLs can serve stale or placeholder content with a 200, so
// retry until the body matches.
const getBodyWhenReady = (url: string, expected: string) =>
  Effect.gen(function* () {
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const body = yield* res.text;
    if (!body.includes(expected)) {
      return yield* Effect.fail(new AssetNotReady({ body }));
    }
    return body;
  }).pipe(
    Effect.retry({
      while: (error) => error instanceof AssetNotReady,
      schedule: Schedule.max([
        Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("3 seconds")]),
        Schedule.recurs(20),
      ]),
    }),
  );

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Prisma.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)), { timeout: 900_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

const trim = (url: string | undefined) => {
  if (!url) throw new Error("expected a url");
  return url.replace(/\/+$/, "");
};

const resolve = (base: string, href: string) =>
  href.startsWith("http") ? href : `${base}${href.startsWith("/") ? "" : "/"}${href}`;

test(
  "serves the index HTML",
  Effect.gen(function* () {
    const url = trim((yield* stack).url);
    const html = yield* getBodyWhenReady(url, '<div id="root">');
    expect(html).toContain("<title>solid-yield on Prisma</title>");
  }),
  { timeout: 180_000 },
);

test(
  "ships the solid-yield app and the API url in the client bundle",
  Effect.gen(function* () {
    const { url, apiUrl } = yield* stack;
    const base = trim(url);
    const html = yield* getBodyWhenReady(base, '<script type="module"');
    const script = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/);
    expect(script).not.toBeNull();
    const js = yield* getBodyWhenReady(resolve(base, script![1]!), "Hello from solid-yield!");
    expect(js).toContain("Styled with Tailwind CSS");
    expect(js).toContain(trim(apiUrl));
  }),
  { timeout: 180_000 },
);

test(
  "compiles tailwind from vite.config.ts",
  Effect.gen(function* () {
    const base = trim((yield* stack).url);
    const html = yield* getBodyWhenReady(base, "stylesheet");
    const link = html.match(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/);
    expect(link).not.toBeNull();
    const css = yield* getBodyWhenReady(resolve(base, link![1]!), ".text-3xl");
    expect(css).toContain(".text-3xl");
  }),
  { timeout: 180_000 },
);

test(
  "the API serves the greeting",
  Effect.gen(function* () {
    const api = trim((yield* stack).apiUrl);
    const body = yield* getBodyWhenReady(`${api}/api/greeting`, "Hello from the Prisma API!");
    expect(JSON.parse(body)).toEqual({
      message: "Hello from the Prisma API!",
      platform: "Prisma",
    });
  }),
  { timeout: 180_000 },
);
