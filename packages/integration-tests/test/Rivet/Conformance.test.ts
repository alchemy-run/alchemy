import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
import { ensureDockerSwarm } from "../Docker/Runtime.ts";
import { FRONT_PORT } from "./fixtures/cluster.ts";
import Front from "./fixtures/front.ts";

const testOptions = { providers: Layer.mergeAll(Docker.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "RivetConformance", import.meta.url);

const baseUrl = `http://localhost:${FRONT_PORT}`;

// The engine conformance spec, run against Rivet Durable Objects on a local
// Docker control plane, called from a Docker service through the gateway.
describe.skipIf(!!process.env.FAST)(
  "Rivet engine conformance",
  { tags: ["provider:rivet", "provider:rivet:durable-object", "local"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        yield* sharedStack.destroy();
        const outputs = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const front = yield* Front;
            return { front: front.name };
          }),
        );
        expect(outputs.front).toBeTruthy();
        yield* waitForReady(baseUrl, { attempts: 40, base: "3 seconds" });
      }),
      { timeout: 400_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 300_000 });

    conformanceTests(test, { baseUrl: () => baseUrl });

    test(
      "a second class on the same pool calls the first through the gateway",
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const greet = client.get(`${baseUrl}/greet/sam`).pipe(
          Effect.flatMap((res) => res.json),
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
        );
        const first = (yield* greet) as { greeting: string };
        const second = (yield* greet) as { greeting: string };
        expect(first.greeting).toMatch(/^hello sam #\d+$/);
        const n = (s: string) => Number(s.split("#")[1]);
        expect(n(second.greeting)).toBe(n(first.greeting) + 1);
      }),
      { timeout: 120_000 },
    );
  },
);
