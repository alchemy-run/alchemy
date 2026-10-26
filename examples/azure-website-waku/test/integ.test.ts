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

// The Waku build, the server Function, the Storage upload and the Front Door endpoint.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

// The Front Door profile delete took 14 to more than 30 minutes in live runs.
// The hook outlasts the provider's own 30-minute delete wait, so a slow
// delete fails with the provider's error instead of a hook timeout.
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
  expect(new URL(String(url)).hostname).toMatch(/\.azurefd\.net$/);
  return String(url).replace(/\/+$/, "");
});

test(
  "Front Door serves the page the server Function renders",
  Effect.gen(function* () {
    const url = yield* base;
    const home = yield* getOk(`${url}/`);
    expect(home.headers["x-azure-ref"]).toBeTruthy();
    // The `GREETING` env value from alchemy.run.ts, read via `getEnv` in the
    // dynamic page: the Function rendered it at request time.
    expect(home.body).toContain("Hello from Waku on Azure!");
    expect(home.body).toContain("This page is rendered by the server on every request.");
  }),
  { timeout: 1_800_000 },
);

test(
  "serves the prerendered about page",
  Effect.gen(function* () {
    const url = yield* base;
    const about = yield* getOk(`${url}/about`);
    expect(about.body).toContain("This page is prerendered at build time");
  }),
  { timeout: 1_800_000 },
);

test(
  "compiles tailwind from waku.config.ts",
  Effect.gen(function* () {
    const url = yield* base;
    const home = yield* getOk(`${url}/`);
    expect(home.body).toContain("text-3xl");
    const links = [...home.body.matchAll(/<link\b[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => /rel="stylesheet"/.test(tag))
      .map((tag) => /href="([^"]+)"/.exec(tag)?.[1])
      .filter((href): href is string => !!href);
    expect(links.length).toBeGreaterThan(0);
    let compiled = "";
    for (const href of links) {
      const css = yield* getOk(href.startsWith("http") ? href : `${url}${href}`);
      compiled += css.body;
    }
    expect(compiled).toContain(".text-3xl");
  }),
  { timeout: 1_800_000 },
);

test(
  "serves a static asset from public/ through Blob Storage",
  Effect.gen(function* () {
    const url = yield* base;
    const hello = yield* getOk(`${url}/hello.txt`);
    expect(hello.body).toContain("hello from public/");
  }),
  { timeout: 1_800_000 },
);
