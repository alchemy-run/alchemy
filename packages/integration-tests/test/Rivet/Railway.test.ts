import * as Hetzner from "@alchemy.run/hetzner";
import * as Railway from "@alchemy.run/railway";
import * as Rivet from "@alchemy.run/rivet";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
import { CounterLive } from "./fixtures/railway/counter-live.ts";
import Front from "./fixtures/railway/front.ts";

const testOptions = {
  providers: Layer.mergeAll(Hetzner.providers(), Railway.providers(), Rivet.providers()),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "RivetRailwayConformance", import.meta.url);

let baseUrl = "";

// The engine conformance spec, run against Rivet Durable Objects on a
// control plane on Hetzner and a pool of nodes on Railway, called from a Railway Service.
// Skipped: Railway is out of scope for now.
describe.skipIf(true)(
  "Rivet on Railway (Hetzner control plane, Railway Service pool)",
  { tags: ["provider:rivet", "provider:hetzner", "provider:railway", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        // NO_DESTROY keeps the stack between runs, so iterate on it.
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const { url } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const front = yield* Front;
            return { url: front.url };
          }).pipe(Effect.provide(CounterLive)),
        );
        expect(url).toBeTruthy();
        baseUrl = String(url).replace(/\/+$/, "");
        yield* waitForReady(baseUrl, { attempts: 40, base: "3 seconds" });
      }),
      { timeout: 1_200_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 900_000 });

    conformanceTests(test, { baseUrl: () => baseUrl, kind: "live" });
    test(
      "Durable Streams: the front appends to and reads a stream on its cloud's Services pool",
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const read = (yield* Effect.suspend(() =>
          client.get(`${baseUrl}/durable-stream/${crypto.randomUUID()}`),
        ).pipe(
          Effect.flatMap((res) => res.json),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
        )) as { messages: unknown[] };
        expect(read.messages).toEqual([
          { user: "a", text: "one" },
          { user: "b", text: "two" },
        ]);
      }),
      { timeout: 180_000 },
    );
  },
);
