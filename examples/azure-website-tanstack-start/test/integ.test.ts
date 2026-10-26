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

// The TanStack Start build, the Flex Consumption Function, Front Door, and the upload.
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
  "Front Door serves the page the Function rendered with the app setting",
  Effect.gen(function* () {
    const url = yield* base;
    expect(new URL(url).hostname).toMatch(/\.azurefd\.net$/);
    const home = yield* getOk(`${url}/`);
    // `GREETING` from alchemy.run.ts, read by the server function on the Function.
    expect(home.body).toContain("Hello from TanStack Start on Azure!");
    expect(home.body).toContain("Styled with Tailwind CSS");
    expect(home.headers["x-azure-ref"]).toBeTruthy();
  }),
  { timeout: 1_800_000 },
);

test(
  "the compiled Tailwind stylesheet comes from Blob Storage",
  Effect.gen(function* () {
    const url = yield* base;
    const home = yield* getOk(`${url}/`);
    const link = home.body.match(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/);
    expect(link).not.toBeNull();
    const css = yield* getOk(new URL(link![1]!, `${url}/`).href);
    expect(css.body).toContain(".text-3xl");
    expect(css.headers["cache-control"]).toContain("immutable");
  }),
  { timeout: 1_800_000 },
);

test(
  "a public file comes from Blob Storage",
  Effect.gen(function* () {
    const url = yield* base;
    const robots = yield* getOk(`${url}/robots.txt`);
    expect(robots.body).toContain("User-agent: *");
  }),
  { timeout: 1_800_000 },
);
