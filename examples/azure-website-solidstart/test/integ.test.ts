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

// The SolidStart build, the Flex Consumption Function, and the Front Door endpoint.
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

/** GET `url` until it answers 200 with `expected`, through a new endpoint's 10-20 minute propagation. */
const getWhenServing = (url: string, expected: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        Effect.flatMap(res.text, (body) =>
          res.status === 200 && body.includes(expected)
            ? Effect.succeed({ body, headers: res.headers })
            : Effect.fail(new Error(`HTTP ${res.status}`)),
        ),
      ),
      Effect.retry({ schedule: Schedule.spaced("30 seconds"), times: 50 }),
    );
  });

test(
  "Front Door serves the page the Function renders",
  Effect.gen(function* () {
    const url = yield* base;
    expect(new URL(url).hostname).toMatch(/\.azurefd\.net$/);
    // The `GREETING` app setting, read via `process.env` in the index
    // route: the Function rendered the page at request time.
    const home = yield* getWhenServing(`${url}/`, "Hello from SolidStart on Azure!");
    expect(home.body).toContain("Styled with Tailwind CSS");
    expect(home.headers["x-azure-ref"]).toBeTruthy();
  }),
  { timeout: 1_800_000 },
);

test(
  "compiles tailwind from vite.config.ts",
  Effect.gen(function* () {
    const url = yield* base;
    const home = yield* getWhenServing(`${url}/`, "text-3xl");
    // SolidStart emits `href` before `rel`: collect every stylesheet link.
    const hrefs = [...home.body.matchAll(/<link\b[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => /rel="stylesheet"/.test(tag))
      .map((tag) => tag.match(/href="([^"]+)"/)?.[1])
      .filter((href): href is string => !!href);
    expect(hrefs.length).toBeGreaterThan(0);
    // The stylesheet comes from Blob Storage; the rule exists only if the
    // @tailwindcss/vite plugin from the project's vite.config.ts ran.
    const css = yield* getWhenServing(new URL(hrefs[0]!, `${url}/`).href, ".text-3xl");
    expect(css.body).toContain(".font-bold");
  }),
  { timeout: 1_800_000 },
);

test(
  "serves a static asset from public/",
  Effect.gen(function* () {
    const url = yield* base;
    const robots = yield* getWhenServing(`${url}/robots.txt`, "User-agent: *");
    expect(robots.body).toContain("Allow: /");
  }),
  { timeout: 1_800_000 },
);
