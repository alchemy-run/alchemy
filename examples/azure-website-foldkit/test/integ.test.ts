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

// The Vite build, Front Door endpoint creation, and the Storage upload.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

// The Front Door profile delete took 14 to more than 30 minutes in live runs.
// The hook outlasts the provider's own 30-minute delete wait, so a slow
// delete fails with the provider's error instead of a hook timeout.
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 2_100_000,
});

/**
 * GET `url` until it answers 200 with `expected` in the body, through a new
 * endpoint's 10-20 minute propagation.
 */
const getOk = (url: string, expected: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.map(res.text, (body) => ({ body, headers: res.headers }))
          : Effect.fail(new Error(`HTTP ${res.status}`)),
      ),
      Effect.filterOrFail(
        (page) => page.body.includes(expected),
        () => new Error(`${url} does not serve "${expected}" yet`),
      ),
      Effect.retry({ schedule: Schedule.spaced("30 seconds"), times: 50 }),
    );
  });

const base = Effect.map(stack, ({ url }) => {
  if (!url) throw new Error("expected the site to expose a url");
  return String(url).replace(/\/+$/, "");
});

test(
  "Front Door serves the SPA shell and its deep links",
  Effect.gen(function* () {
    const url = yield* base;
    expect(new URL(url).hostname).toMatch(/\.azurefd\.net$/);
    const home = yield* getOk(`${url}/`, "<title>Foldkit on Azure</title>");
    expect(home.headers["x-azure-ref"]).toBeTruthy();
    // A client-side route answers with the app shell and a 200.
    const deepLink = yield* getOk(`${url}/counter/42`, "<title>Foldkit on Azure</title>");
    expect(deepLink.headers["x-azure-ref"]).toBeTruthy();
  }),
  { timeout: 1_800_000 },
);

test(
  "Blob Storage serves the app bundle and the Tailwind CSS",
  Effect.gen(function* () {
    const url = yield* base;
    const home = yield* getOk(`${url}/`, "<title>Foldkit on Azure</title>");
    const script = home.body.match(/<script[^>]+src="([^"]+)"/);
    expect(script).not.toBeNull();
    const js = yield* getOk(new URL(script![1]!, `${url}/`).href, "Hello from Foldkit!");
    expect(js.body).toContain("Styled with Tailwind CSS");
    expect(js.headers["cache-control"]).toContain("immutable");
    const link = home.body.match(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/);
    expect(link).not.toBeNull();
    const css = yield* getOk(new URL(link![1]!, `${url}/`).href, ".text-3xl");
    expect(css.body).toContain(".text-3xl");
  }),
  { timeout: 1_800_000 },
);
