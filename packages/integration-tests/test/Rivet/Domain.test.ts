import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ensureDockerSwarm } from "../Docker/Runtime.ts";
import { conformance, waitForReady } from "../Domain/conformance/conformance.ts";
import { DOMAIN_FRONT_PORT } from "./fixtures/domain-cluster.ts";
import DomainFront from "./fixtures/domain-front.ts";

const testOptions = { providers: Layer.mergeAll(Docker.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const stack = Core.scratchStack(testOptions, "RivetDomain", import.meta.url);

const url = `http://localhost:${DOMAIN_FRONT_PORT}`;

// The Domain conformance suite, with the model on Rivet Durable Objects on a
// local Docker control plane, called from a Docker service through the gateway.
describe.skipIf(!!process.env.FAST)(
  "Domain on Rivet",
  { tags: ["provider:rivet", "provider:rivet:domain", "local"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        if (!process.env.NO_DESTROY) yield* stack.destroy();
        const outputs = yield* stack.deploy(
          Effect.gen(function* () {
            const front = yield* DomainFront;
            return { front: front.name };
          }),
        );
        expect(outputs.front).toBeTruthy();
        yield* waitForReady(url);
      }),
      { timeout: 400_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(stack.destroy(), { timeout: 300_000 });

    conformance({ test, url: Effect.succeed(url), kind: "local" });
  },
);
