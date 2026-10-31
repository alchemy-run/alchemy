import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
import { ensureDockerSwarm } from "../Docker/Runtime.ts";
import ConformanceWorker from "./fixtures/conformance-worker.ts";

const testOptions = { providers: Layer.mergeAll(Docker.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "RivetConformance", import.meta.url);

let baseUrl = "";

// The engine conformance spec, run against a Rivet Worker whose Durable
// Objects are Rivet actors on a local Docker control plane.
describe.skipIf(!!process.env.FAST)(
  "Rivet engine conformance",
  { tags: ["provider:rivet", "provider:rivet:worker", "local"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        yield* sharedStack.destroy();
        const { url } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const worker = yield* ConformanceWorker;
            return { url: worker.url };
          }),
        );
        expect(url).toBeTruthy();
        baseUrl = String(url).replace(/\/+$/, "");
        yield* Effect.logInfo(`Rivet conformance worker: ${baseUrl}`);
        yield* waitForReady(baseUrl, { attempts: 40, base: "3 seconds" });
      }),
      { timeout: 400_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 300_000 });

    conformanceTests(test, { baseUrl: () => baseUrl });
  },
);
