import * as AWS from "@/AWS";
import * as Celld from "@/Celld";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import CellsWorker, { Cells } from "./fixtures/worker-inline.ts";

const testOptions = {
  providers: Layer.mergeAll(AWS.providers(), Celld.providers()),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CelldInline");

let workerUrl: string;

// The single-file inline form — Fleet + inline `Cloudflare.DurableObject`
// + `Celld.Worker` class carrying its props and impl in one declaration.
// Deploys the whole thing and asserts the deployed shape.
describe.skipIf(!!process.env.FAST)("Celld inline Worker (live)", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      const { url } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          yield* Cells;
          const worker = yield* CellsWorker;
          return { url: worker.url };
        }),
      );
      expect(url).toBeTruthy();
      workerUrl = String(url);
      yield* Effect.logInfo(`Celld inline worker deployed at ${workerUrl}`);
    }),
    { timeout: 900_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 1_800_000,
  });

  test(
    "the inline worker deploys and exposes its fleet URL",
    Effect.gen(function* () {
      // The fleet endpoint is VPC-internal (Cloud Map DNS), so the assertion
      // is on the deployed shape; the request path itself is covered by the
      // tagged-form suite's Lambda caller.
      expect(workerUrl).toMatch(/^http:\/\/.+:8080$/);
    }),
    { timeout: 60_000 },
  );
});
