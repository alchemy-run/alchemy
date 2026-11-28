import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ensureDockerSwarm, publishedUrl } from "../Docker/Runtime.ts";
import { hosted, waitForReady } from "./hosted/conformance.ts";
import HostedRivetFront from "./hosted/rivet/front.ts";

const testOptions = { providers: Layer.mergeAll(Docker.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const stack = Core.scratchStack(testOptions, "RivetHosted", import.meta.url);

// The front's port is one Swarm picks, read from the deploy.
let url = "";
const frontUrl = Effect.sync(() => url);

// A process and the model it works with, both on Rivet Durable Objects on a
// local Docker control plane, called from a Docker service through the gateway.
describe.skipIf(!!process.env.FAST)(
  "AI processes on Rivet",
  { tags: ["provider:rivet", "provider:rivet:ai", "local"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        if (!process.env.NO_DESTROY) yield* stack.destroy();
        const { front, ports } = yield* stack.deploy(
          Effect.gen(function* () {
            const front = yield* HostedRivetFront;
            return { front: front.name, ports: front.ports };
          }),
        );
        expect(front).toBeTruthy();
        url = publishedUrl(ports);
        yield* waitForReady(url);
      }),
      { timeout: 400_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(stack.destroy(), { timeout: 300_000 });

    hosted({ test, url: frontUrl });
  },
);
