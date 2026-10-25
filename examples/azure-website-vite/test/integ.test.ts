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

// The Front Door profile delete takes 5-20 minutes.
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 1_800_000,
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

test(
  "Front Door serves the SPA and its deep links",
  Effect.gen(function* () {
    const { url } = yield* stack;
    if (!url) throw new Error("expected the site to expose a url");
    const base = String(url).replace(/\/+$/, "");
    expect(new URL(base).hostname).toMatch(/\.azurefd\.net$/);

    const home = yield* getOk(`${base}/`);
    expect(home.body).toContain("Hello — Azure");
    expect(home.headers["x-azure-ref"]).toBeTruthy();

    // A client-side route answers with the app shell and a 200.
    const deepLink = yield* getOk(`${base}/counter/42`);
    expect(deepLink.body).toContain("Hello — Azure");
  }),
  { timeout: 1_800_000 },
);
