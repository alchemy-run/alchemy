import * as Docker from "@alchemy.run/docker";
import * as DomainEffectCluster from "@alchemy.run/domain/EffectCluster";
import * as Cluster from "@alchemy.run/effect-cluster";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { domainRevisions, ensureDockerSwarm, publishedUrl } from "../Docker/Runtime.ts";
import { conformance, rebuild, waitForReady } from "../Domain/conformance/conformance.ts";
import { latency } from "../Domain/conformance/latency.ts";
import { connections } from "./fixtures/domain/connections.ts";
import { crash } from "./fixtures/domain/crash.ts";
import DomainFrontV1 from "./fixtures/domain/front-v1.ts";
import DomainFront from "./fixtures/domain/front.ts";
import { beginsNewRun } from "./fixtures/domain/runs.ts";

const testOptions = {
  providers: Layer.mergeAll(
    Docker.providers(),
    Cluster.providers(),
    DomainEffectCluster.providers(),
  ),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
const stack = Core.scratchStack(testOptions, "ClusterDomain", import.meta.url);

// The front's port is one Swarm picks, read from each deploy.
let url = "";
const frontUrl = Effect.sync(() => url);
// The front's service name: its stack's services hold the model's revisions.
let front = "";

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
      Effect.tap(({ front: name, ports }) =>
        Effect.suspend(() => {
          front = name;
          url = publishedUrl(ports);
          return waitForReady(url);
        }),
      ),
      Effect.map(({ front }) => front),
    );

// The Domain conformance suite, with the model on Effect Cluster entities on
// two local Docker runners coordinating through Postgres, called from a
// Docker service through the gateway. The crash cases then SIGKILL one
// runner at a time.
describe.skipIf(!!process.env.FAST)(
  "Domain on Effect Cluster",
  { tags: ["provider:cluster", "provider:cluster:domain", "provider:docker", "local"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        if (!process.env.NO_DESTROY) yield* stack.destroy();
        expect(yield* deploy(0)).toBeTruthy();
      }),
      { timeout: 600_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(stack.destroy(), { timeout: 300_000 });

    test(
      "the runners run with the model's revision",
      Effect.gen(function* () {
        expect(yield* domainRevisions(front)).toEqual({ DomainObjects: { Conformance: 1 } });
      }),
    );

    conformance({ test, url: frontUrl, kind: "local" });
    connections({ test, url: () => url, stack });
    latency({
      kind: "local",
      test,
      label: "Effect Cluster (local Docker)",
      url: frontUrl,
    });

    // After the cases that read the model as deployed: it redeploys the front.
    // The bump's new runners begin its new run before the case calls the model.
    rebuild({
      test,
      url: frontUrl,
      kind: "local",
      deploy: (v) =>
        v === 1 ? beginsNewRun(stack, Effect.asVoid(deploy(1))) : Effect.asVoid(deploy(v)),
    });

    // Last: each case kills a runner.
    crash({ test, url: () => url, stack });
  },
);
