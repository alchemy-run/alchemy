import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ensureDockerSwarm } from "../Docker/Runtime.ts";
import { conformance, rebuild, waitForReady } from "../Domain/conformance/conformance.ts";
import { latency } from "../Domain/conformance/latency.ts";
import DomainFrontV1 from "./fixtures/domain-front-v1.ts";
import DomainFront from "./fixtures/domain-front.ts";
import { publishedUrl } from "./fixtures/published.ts";

const testOptions = { providers: Layer.mergeAll(Docker.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const stack = Core.scratchStack(testOptions, "RivetDomain", import.meta.url);

// The front's port is one Swarm picks, read from each deploy.
let url = "";
const frontUrl = Effect.sync(() => url);

/** Deploy the front over the model at `version`, and wait until it serves. */
const deploy = (version: 0 | 1) =>
  stack
    .deploy(
      Effect.gen(function* () {
        const front = yield* version === 0 ? DomainFront : DomainFrontV1;
        return { front: front.name, ports: front.ports };
      }),
    )
    .pipe(
      Effect.tap(({ ports }) =>
        Effect.suspend(() => {
          url = publishedUrl(ports);
          return waitForReady(url);
        }),
      ),
      Effect.map(({ front }) => front),
    );

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
        expect(yield* deploy(0)).toBeTruthy();
      }),
      { timeout: 400_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(stack.destroy(), { timeout: 300_000 });

    conformance({ test, url: frontUrl, kind: "local" });
    latency({
      kind: "local",
      test,
      label: "Rivet (local Docker)",
      url: frontUrl,
    });

    // After the cases that read the model as deployed: it redeploys the front.
    rebuild({
      test,
      url: frontUrl,
      kind: "local",
      deploy: (v) => Effect.asVoid(deploy(v)),
    });
  },
);
