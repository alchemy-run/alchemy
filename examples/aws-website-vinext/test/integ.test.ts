import * as AWS from "alchemy/AWS";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
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

const hasCreds = !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE);

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
  state: AWS.state(),
  stage: "test",
});

if (!hasCreds) {
  test.skip("skipped without AWS credentials", Effect.void);
} else {
  const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)), {
    timeout: 1_200_000,
  });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
    timeout: 1_200_000,
  });

  const base = Effect.map(stack, ({ url }) => {
    if (!url) throw new Error("expected the site to expose a CloudFront url");
    return String(url).replace(/\/+$/, "");
  });

  test(
    "deploys and exposes a url",
    Effect.gen(function* () {
      const { url } = yield* stack;
      expect(url).toBeString();
    }),
    { timeout: 180_000 },
  );

  test(
    "serves the server-rendered home page",
    Effect.gen(function* () {
      const url = yield* base;
      const res = yield* getWhenReady(url);
      expect(res.status).toBe(200);
      const html = yield* res.text;
      expect(html).toContain("vinext on AWS");
      expect(html).toContain("Hello from vinext on AWS!");
    }),
    { timeout: 180_000 },
  );

  test(
    "serves the dynamic API route",
    Effect.gen(function* () {
      const url = yield* base;
      const res = yield* getWhenReady(`${url}/api/hello`);
      expect(res.status).toBe(200);
      const body = (yield* res.json) as { hello: string };
      expect(body.hello).toBe("world");
    }),
    { timeout: 180_000 },
  );

  test(
    "compiles tailwind via vite",
    Effect.gen(function* () {
      const url = yield* base;
      const html = yield* getBodyWhenReady(url, "text-3xl");
      expect(html).toContain("text-3xl");
    }),
    { timeout: 180_000 },
  );

  test(
    "serves a static asset from public/",
    Effect.gen(function* () {
      const url = yield* base;
      const body = yield* getBodyWhenReady(
        `${url}/robots.txt`,
        "User-agent: *",
      );
      expect(body).toContain("User-agent: *");
    }),
    { timeout: 180_000 },
  );
}
