import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { conformanceTests, waitForReady } from "../spec.ts";
import ConformanceWorkerLive, { ConformanceWorker } from "./worker.ts";

const testOptions = { providers: Cloudflare.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CfConformance");

let baseUrl = "";

// The portable conformance spec, run against a REAL Cloudflare Worker with
// real Durable Objects.
describe.skipIf(!!process.env.FAST)("Cloudflare engine conformance", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      const { url } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          const worker = yield* ConformanceWorker;
          return { url: worker.url };
        }).pipe(Effect.provide(ConformanceWorkerLive)),
      );
      expect(url).toBeTruthy();
      baseUrl = String(url).replace(/\/+$/, "");
      yield* Effect.logInfo(`Cloudflare conformance worker: ${baseUrl}`);
      yield* waitForReady(baseUrl);
    }),
    { timeout: 300_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 300_000,
  });

  conformanceTests(test as any, {
    baseUrl: () => baseUrl,
    // Cloudflare Durable Objects support the whole surface.
    capabilities: { sql: true, alarms: true },
  });
});
