import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

// `next build`, the Flex Consumption Function, Front Door, and the upload.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

// The Front Door profile delete took 14 to more than 30 minutes in live runs.
// The hook outlasts the provider's own 30-minute delete wait.
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 2_100_000,
});

/** GET `url` until it answers 200, through a new endpoint's 10-20 minute propagation. */
const getOk = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.map(res.text, (body) => ({ body, headers: res.headers }))
          : Effect.fail(new Error(`HTTP ${res.status}`)),
      ),
      Effect.retry({ schedule: Schedule.spaced("30 seconds"), times: 50 }),
    );
  });

const base = Effect.map(stack, ({ url }) => {
  if (!url) throw new Error("expected the site to expose a url");
  return String(url).replace(/\/+$/, "");
});

test(
  "Front Door serves the page rendered by the Function",
  Effect.gen(function* () {
    const url = yield* base;
    expect(new URL(url).hostname).toMatch(/\.azurefd\.net$/);
    const home = yield* getOk(`${url}/`);
    expect(home.body).toContain("Next.js on Azure");
    // The GREETING app setting, read by the force-dynamic page at request time.
    expect(home.body).toContain("Hello from Next.js on Azure!");
    expect(home.headers["x-azure-ref"]).toBeTruthy();
    expect(home.headers["x-powered-by"]).toBe("Next.js");
  }),
  { timeout: 1_800_000 },
);

test(
  "serves the App Router route handler",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getOk(`${url}/api/hello`);
    expect(JSON.parse(res.body)).toEqual({ hello: "world" });
  }),
  { timeout: 1_800_000 },
);

test(
  "serves the compiled Tailwind stylesheet from Blob Storage",
  Effect.gen(function* () {
    const url = yield* base;
    const home = yield* getOk(`${url}/`);
    const stylesheet = home.body.match(/\/_next\/static\/[^"']+\.css/)?.[0];
    expect(stylesheet).toMatch(/^\/_next\/static\//);
    const css = yield* getOk(`${url}${stylesheet}`);
    expect(css.body).toContain(".text-3xl");
    expect(css.headers["cache-control"]).toBe("max-age=31536000,public,immutable");
  }),
  { timeout: 1_800_000 },
);

test(
  "serves a static asset from public/",
  Effect.gen(function* () {
    const url = yield* base;
    const robots = yield* getOk(`${url}/robots.txt`);
    expect(robots.body).toContain("User-agent: *");
    expect(robots.headers["x-powered-by"]).toBeUndefined();
  }),
  { timeout: 1_800_000 },
);
