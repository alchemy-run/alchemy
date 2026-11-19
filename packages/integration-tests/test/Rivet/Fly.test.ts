import * as Fly from "@alchemy.run/fly";
import * as Rivet from "@alchemy.run/rivet";
import * as RivetFly from "@alchemy.run/rivet/Fly";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
import { expectDurableStream } from "./fixtures/durable-stream-check.ts";
import { Cluster } from "./fixtures/fly/cluster.ts";
import { CounterLive } from "./fixtures/fly/counter-live.ts";
import Front from "./fixtures/fly/front.ts";
import { expectRustCounter, RustActors, rustTarget, type RustTarget } from "./fixtures/rust.ts";

const testOptions = { providers: Layer.mergeAll(Fly.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "RivetFlyConformance", import.meta.url);

let baseUrl = "";
let rust: RustTarget;

// A Rust Durable Object on a pool of its own: Fly builds its crate's image.
const RustPool = RivetFly.MachinePool("Rust").pipe(Layer.provide(Cluster));

// The engine conformance spec, run against Rivet Durable Objects on a
// control plane of Fly Machines and a pool on a Fly Service, called from a Fly Service.
describe.skipIf(!!process.env.FAST)(
  "Rivet on Fly (Machines control plane, Fly Service pool)",
  { tags: ["provider:rivet", "provider:fly", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        // NO_DESTROY keeps the stack between runs, so iterate on it.
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const front = yield* Front;
            const actors = yield* RustActors().pipe(Effect.provide(RustPool));
            return { url: front.url, rust: rustTarget(actors) };
          }).pipe(Effect.provide(CounterLive)),
        );
        const url = out.url;
        rust = out.rust as typeof rust;
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
      "a Rust Durable Object runs on a Fly Service pool",
      Effect.gen(function* () {
        yield* expectRustCounter(rust, "fly-rust");
      }),
      { timeout: 300_000 },
    );
  },
);
