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

// Front Door endpoint creation plus the Storage upload.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

// The Front Door profile delete took 14 to more than 30 minutes in live runs.
// The hook outlasts the provider's own 30-minute delete wait, so a slow
// delete fails with the provider's error instead of a hook timeout.
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 2_100_000,
});

const base = Effect.map(stack, ({ url }) => {
  if (!url) throw new Error("expected the site to expose a url");
  return String(url).replace(/\/+$/, "");
});

/** GET `url` until it answers `status`, through a new endpoint's 10-20 minute propagation. */
const getWhen = (url: string, status = 200) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === status
          ? Effect.map(res.text, (body) => ({ body, headers: res.headers }))
          : Effect.fail(new Error(`HTTP ${res.status}`)),
      ),
      Effect.retry({ schedule: Schedule.spaced("30 seconds"), times: 50 }),
    );
  });

test(
  "Front Door serves the built page",
  Effect.gen(function* () {
    const url = yield* base;
    expect(new URL(url).hostname).toMatch(/\.azurefd\.net$/);

    const home = yield* getWhen(`${url}/`);
    expect(home.body).toContain("Static site on Azure");
    expect(home.headers["x-azure-ref"]).toBeTruthy();
  }),
  { timeout: 1_800_000 },
);

test(
  "serves the static JSON asset and the compiled script",
  Effect.gen(function* () {
    const url = yield* base;
    const json = yield* getWhen(`${url}/example.json`);
    expect(JSON.parse(json.body)).toEqual({
      framework: "Static site",
      greeting: "Hello from Static site on Azure!",
    });

    const home = yield* getWhen(`${url}/`);
    const source = /<script[^>]+src="([^"]+\.js)"/.exec(home.body)?.[1];
    if (!source) throw new Error("expected a compiled JavaScript entry");
    const script = yield* getWhen(new URL(source, `${url}/`).href);
    expect(script.headers["content-type"]).toMatch(/javascript/);
    expect(script.body.trimStart().startsWith("<!doctype")).toBe(false);
  }),
  { timeout: 1_800_000 },
);

test(
  "answers an unknown path with the 404 page",
  Effect.gen(function* () {
    const url = yield* base;
    const missing = yield* getWhen(`${url}/no-such-page`, 404);
    expect(missing.body).toContain("Page not found");
    expect(missing.headers["x-azure-ref"]).toBeTruthy();
  }),
  { timeout: 1_800_000 },
);
