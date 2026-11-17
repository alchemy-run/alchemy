import * as GCP from "@alchemy.run/gcp";
import * as Rivet from "@alchemy.run/rivet";
import * as RivetGCP from "@alchemy.run/rivet/GCP";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
import { expectDurableStream } from "./fixtures/durable-stream-check.ts";
import { Cluster } from "./fixtures/gcp-compute/cluster.ts";
import { CounterLive } from "./fixtures/gcp-compute/counter-live.ts";
import Front from "./fixtures/gcp-compute/front.ts";
import { expectRustCounter, RustActors, rustTarget, type RustTarget } from "./fixtures/rust.ts";

const testOptions = { providers: Layer.mergeAll(GCP.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "RivetGcpComputeConformance", import.meta.url);

let baseUrl = "";
let rust: RustTarget;

// A Rust Durable Object on a pool of its own.
const RustPool = RivetGCP.ComputeEnginePool("Rust").pipe(Layer.provide(Cluster));

// The engine conformance spec, run against Rivet Durable Objects on a
// control plane and a pool of nodes on Compute Engine, called from Cloud Run.
describe.skipIf(!!process.env.FAST)(
  "Rivet on GCP (Compute control plane, Compute pool)",
  { tags: ["provider:rivet", "provider:gcp", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        // NO_DESTROY keeps the stack between runs, so iterate on it.
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const front = yield* Front;
            const actors = yield* RustActors().pipe(Effect.provide(RustPool));
            return { url: front.uri, rust: rustTarget(actors) };
          }).pipe(Effect.provide(CounterLive)),
        );
        const url = out.url;
        rust = out.rust as RustTarget;
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
      Effect.suspend(() => expectDurableStream(baseUrl)),
      { timeout: 180_000 },
    );

    test(
      "a Rust Durable Object runs on a Compute Engine pool",
      Effect.gen(function* () {
        yield* expectRustCounter(rust, "gcpcompute-rust");
      }),
      { timeout: 300_000 },
    );
  },
);
