import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { getWhenReady } = Test;

class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  body: string;
}> {}

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
        Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("3 seconds"),
        ]),
        Schedule.recurs(20),
      ]),
    }),
  );

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Fly.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

const stack = beforeAll(deploy(Stack), { timeout: 180_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 120_000,
});

const base = Effect.map(stack, ({ url }) => {
  if (!url) throw new Error("expected the site to expose a fly.dev url");
  return String(url).replace(/\/+$/, "");
});

test(
  "deploys and exposes a fly.dev url",
  Effect.gen(function* () {
    const { url, appName } = yield* stack;
    expect(url).toBeString();
    expect(url).toMatch(/^https:\/\/.+\.fly\.dev$/);
    expect(appName).toBeString();
  }),
  { timeout: 120_000 },
);

test(
  "serves the built Vite SPA",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(url, "Fly.Website.Vite");
    expect(html).toContain("alchemy + vite");
  }),
  { timeout: 120_000 },
);
