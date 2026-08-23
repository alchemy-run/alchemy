import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { expectUrlContains } from "../Utils/Http.ts";

/**
 * Precreate registers a Worker's Durable Object classes, then reconcile's
 * settings read can 404 "has no versions" and the deploy re-sends
 * `new_sqlite_classes`, which Cloudflare rejects. Everything here hits the
 * real API except those two reads.
 */

const settingsPath = /\/workers\/scripts\/[^/]+\/settings$/;

const race = { observed: false, injected: 0 };

const noVersions = () =>
  new Response(
    JSON.stringify({
      success: false,
      errors: [{ code: 10007, message: "Worker has no versions" }],
      messages: [],
      result: null,
    }),
    { status: 404, headers: { "content-type": "application/json" } },
  );

const racingFetch: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  if (
    request.method !== "GET" ||
    !settingsPath.test(new URL(request.url).pathname)
  ) {
    return fetch(input, init);
  }
  if (race.observed && race.injected < 2) {
    race.injected++;
    return noVersions();
  }
  const response = await fetch(input, init);
  if (
    response.status === 200 &&
    (await response.clone().text()).includes('"namespace_id"')
  ) {
    race.observed = true;
  }
  return response;
};

const { test } = Test.make({
  providers: Cloudflare.providers().pipe(
    Layer.provideMerge(
      Layer.fresh(FetchHttpClient.layer).pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, racingFetch)),
      ),
    ),
  ),
});

const script = `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async increment() {
    const next = ((await this.ctx.storage.get("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", next);
    return next;
  }
}
export default {
  async fetch(request, env) {
    const value = await env.Counter.getByName("shared").increment();
    return new Response("count=" + value);
  },
};`;

test.provider(
  "deploy survives a settings read that races the precreated durable object",
  (stack) =>
    Effect.gen(function* () {
      race.observed = false;
      race.injected = 0;
      yield* stack.destroy();

      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("do-precreate-race", {
              script,
              env: { Counter: Cloudflare.DurableObject("Counter") },
            }),
          };
        }),
      );

      expect(race.injected).toBe(2);
      expect(Object.keys(worker.durableObjectNamespaces)).toEqual(["Counter"]);
      yield* expectUrlContains(worker.url!, "count=");

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);
