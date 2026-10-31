import * as AWS from "@alchemy.run/aws";
import * as Rivet from "@alchemy.run/rivet";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
import { CounterLive } from "./fixtures/aws/counter-live.ts";
import Front from "./fixtures/aws/front.ts";

const testOptions = { providers: Layer.mergeAll(AWS.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "RivetAwsConformance", import.meta.url);

let baseUrl = "";

// The engine conformance spec, run against Rivet Durable Objects on a
// control plane on EC2 and a pool on ECS Fargate, called from a Lambda.
describe.skipIf(!!process.env.FAST)(
  "Rivet on AWS (EC2 control plane, ECS pool)",
  { tags: ["provider:rivet", "provider:aws", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
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

    conformanceTests(test, { baseUrl: () => baseUrl });
  },
);
