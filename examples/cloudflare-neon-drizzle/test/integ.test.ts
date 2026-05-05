import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(
    Cloudflare.providers(),
    Drizzle.providers(),
    Neon.providers(),
  ),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "worker exposes a URL, hyperdrive id, and neon branch id",
  Effect.gen(function* () {
    const { url, branchId, hyperdriveId } = yield* stack;

    expect(url).toBeString();
    expect(branchId).toBeString();
    expect(hyperdriveId).toBeString();
  }),
);

// workers.dev subdomain takes a few seconds to propagate after first
// enable; retry until the worker actually answers.
const getOnce = (url: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(url);
    if (response.status === 404) {
      return yield* Effect.fail(new Error("workers.dev not yet propagated"));
    }
    return response;
  }).pipe(Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }));

test(
  "GET / returns the empty `users` table through Drizzle / Hyperdrive / Neon",
  Effect.gen(function* () {
    const { url } = yield* stack;

    const response = yield* getOnce(url);
    expect(response.status).toBe(200);

    const body = (yield* response.json) as unknown[];
    expect(body).toEqual([]);
  }),
);

test(
  "second request reuses the worker-scoped pg pool",
  Effect.gen(function* () {
    const { url } = yield* stack;

    // Regression guard for the Layer.buildWithScope fix: before it, the
    // first request succeeded but every subsequent request failed with
    // "Cannot use a pool after calling end on the pool". Hit a few
    // times and require ≥ 2 of them to be 200 — that's enough to prove
    // the pool stays alive across requests, while tolerating the
    // occasional Cloudflare 1101 transient on cold isolates.
    let ok = 0;
    for (let i = 0; i < 4; i++) {
      const response = yield* getOnce(`${url}?n=${i}`);
      if (response.status === 200) ok += 1;
    }
    expect(ok).toBeGreaterThanOrEqual(2);
  }),
);
