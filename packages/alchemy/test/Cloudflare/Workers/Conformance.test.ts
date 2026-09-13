import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { conformanceTests, waitForReady } from "./conformance/spec.ts";
import ConformanceWorker from "./fixtures/conformance-worker.ts";

const testOptions = { providers: Cloudflare.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` below really drains
// whatever a previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(
  testOptions,
  "CfConformance",
  import.meta.url,
);

let baseUrl = "";

// The engine conformance spec, run against a REAL Cloudflare Worker with
// real Durable Objects.
describe.skipIf(!!process.env.FAST)("Cloudflare engine conformance", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      const { url } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          const worker = yield* ConformanceWorker;
          return { url: worker.url };
        }),
      );
      expect(url).toBeTruthy();
      baseUrl = String(url).replace(/\/+$/, "");
      yield* Effect.logInfo(`Cloudflare conformance worker: ${baseUrl}`);
      // Default budget (~2.5 min) — workers.dev propagation after a first
      // deploy — fits inside this hook's timeout.
      yield* waitForReady(baseUrl);
    }),
    { timeout: 300_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 300_000,
  });

  conformanceTests(test, { baseUrl: () => baseUrl });
});
