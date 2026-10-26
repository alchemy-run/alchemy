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

// The Astro build, the Flex Consumption Function, Front Door, and the upload.
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
  "the Azure Function renders the home page behind Front Door",
  Effect.gen(function* () {
    const url = yield* base;
    expect(new URL(url).hostname).toMatch(/\.azurefd\.net$/);
    const home = yield* getOk(`${url}/`, "Hello from Astro on Azure!");
    expect(home.headers["x-azure-ref"]).toBeTruthy();
    // The `GREETING` app setting, read through `process.env` at request time.
    expect(home.body).toContain("server-rendered in an Azure Function");
  }),
  { timeout: 1_800_000 },
);

test(
  "Blob Storage serves the prerendered page, public/ files, and the Tailwind CSS",
  Effect.gen(function* () {
    const url = yield* base;
    const about = yield* getOk(`${url}/about/`, "This page was prerendered at build time.");
    expect(about.headers["x-azure-ref"]).toBeTruthy();
    const robots = yield* getOk(`${url}/robots.txt`, "User-agent: *");
    expect(robots.headers["cache-control"]).toContain("immutable");

    // Astro links the compiled stylesheet or inlines it; either way the rule
    // exists only if the @tailwindcss/vite plugin from astro.config.ts ran.
    const home = yield* getOk(`${url}/`, "text-3xl");
    const link = home.body.match(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/);
    if (link) {
      const css = yield* getOk(new URL(link[1]!, `${url}/`).href, ".text-3xl");
      expect(css.body).toContain(".text-3xl");
    } else {
      const style = home.body.match(/<style[^>]*>([\s\S]*?)<\/style>/);
      expect(style?.[1]).toContain(".text-3xl");
    }
  }),
  { timeout: 1_800_000 },
);
