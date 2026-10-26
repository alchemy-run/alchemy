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

// The Vocs build, the server Function, the Storage upload and the Front Door endpoint.
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
  "Front Door serves the documentation pages the server Function renders",
  Effect.gen(function* () {
    const url = yield* base;
    const home = yield* getOk(`${url}/`);
    expect(home.headers["x-azure-ref"]).toBeTruthy();
    expect(home.body).toContain("Alchemy with Vocs");

    const guide = yield* getOk(`${url}/guide`);
    expect(guide.body).toContain("Deployment guide");

    const counter = yield* getOk(`${url}/counter`);
    expect(counter.body).toContain("Interactive component");
  }),
  { timeout: 1_800_000 },
);

test(
  "serves public and generated assets from Blob Storage",
  Effect.gen(function* () {
    const url = yield* base;
    const asset = yield* getOk(`${url}/hello.txt`);
    expect(asset.body).toContain("Vocs public directory");

    const llms = yield* getOk(`${url}/llms.txt`);
    expect(llms.body).toContain("Alchemy with Vocs");
  }),
  { timeout: 1_800_000 },
);
