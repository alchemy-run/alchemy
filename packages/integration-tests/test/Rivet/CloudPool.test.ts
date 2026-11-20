import * as AWS from "@alchemy.run/aws";
import * as Rivet from "@alchemy.run/rivet";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
import { CounterLive } from "./fixtures/cloud-pool/counter-live.ts";
import Front from "./fixtures/cloud-pool/front.ts";
import { expectDurableStream } from "./fixtures/durable-stream-check.ts";

const testOptions = { providers: Layer.mergeAll(AWS.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "RivetCloudPoolConformance", import.meta.url);

let baseUrl = "";

// The engine conformance spec, run against Rivet Durable Objects on nodes
// Rivet Cloud runs (a RivetCloud.Pool), called from a Lambda. Each deploy
// that changes the node program builds an image with the local docker CLI
// and uploads it, and Rivet takes minutes to prepare it. Deploys sign in with the RivetCloud profile
// (`alchemy profile edit --add RivetCloud`) or RIVET_CLOUD_TOKEN and
// RIVET_CLOUD_CLUSTER.
describe.skipIf(!!process.env.FAST)(
  "Rivet Cloud (RivetCloud.Pool)",
  { tags: ["provider:rivet", "provider:rivet:cloud", "provider:aws", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        // NO_DESTROY keeps the stack between runs, so iterate on it.
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const { url } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const front = yield* Front;
            return { url: front.functionUrl };
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
      Effect.suspend(() => expectDurableStream(baseUrl)),
      { timeout: 180_000 },
    );
  },
);
