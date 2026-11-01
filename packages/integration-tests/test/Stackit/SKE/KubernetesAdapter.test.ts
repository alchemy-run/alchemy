import * as Kubernetes from "@alchemy.run/kubernetes";
import { connectCluster, readObject } from "@alchemy.run/kubernetes/Client";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { stackitTags } from "../helpers.ts";
import { CLUSTER_TEST_TIMEOUT, slow } from "./cluster.ts";
import SkeEffectServerLive, { SkeEffectServer } from "./fixtures/effect-server.ts";
import { AdapterCluster, AdapterZone, REGISTRY } from "./fixtures/resources.ts";

const providers = Layer.mergeAll(Stackit.providers(), Kubernetes.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const ASYNC_GREETING = "hello from an async workload";

const Stack = Alchemy.Stack(
  "StackitSkeAdapterStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const cluster = yield* AdapterCluster;
    const zone = yield* AdapterZone;
    const image = yield* Kubernetes.Deployment("SkeImageServer", {
      cluster,
      image: "nginx:1.27",
      port: 80,
      serviceType: "LoadBalancer",
    });
    const built =
      REGISTRY === undefined
        ? undefined
        : yield* Effect.gen(function* () {
            const effectServer = yield* SkeEffectServer;
            const asyncServer = yield* Kubernetes.Deployment("SkeAsyncServer", {
              cluster,
              main: pathe.resolve(import.meta.dirname, "fixtures/async-server.ts"),
              port: 3000,
              serviceType: "LoadBalancer",
              env: { GREETING: ASYNC_GREETING },
            });
            return { effectServer, asyncServer };
          }).pipe(Effect.provide(SkeEffectServerLive));
    return {
      connection: cluster.connection,
      zoneId: zone.zoneId,
      imageUrl: image.url,
      imageObjects: image.kubernetesObjects,
      effectUrl: built?.effectServer.url,
      asyncUrl: built?.asyncServer.url,
    };
  }),
);

class NotServing extends Data.TaggedError("NotServing")<{ readonly detail: string }> {}

/** Bounded wait for a fresh load balancer: it refuses connections at first. */
const getText = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.timeout("20 seconds"),
    Effect.flatMap((response) =>
      Effect.gen(function* () {
        if (response.status !== 200) {
          return yield* new NotServing({ detail: `status ${response.status}` });
        }
        return yield* response.text;
      }),
    ),
    Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 30 }),
  );

// `blocked: cost`. The cluster for about three started hours (EUR 0.48), plus up
// to three load balancers. Gated behind STACKIT_TEST_SLOW; the two forms
// that build an image also need STACKIT_TEST_REGISTRY.
describe.sequential.skipIf(slow)(
  "Kubernetes workloads on a STACKIT SKE cluster",
  { tags: [...stackitTags("ske", "kubernetes-adapter"), "provider:kubernetes"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: CLUSTER_TEST_TIMEOUT });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: CLUSTER_TEST_TIMEOUT });

    test(
      "the adapter connects with minted credentials and applies objects",
      Effect.gen(function* () {
        const { connection, imageObjects } = yield* stack;
        const transport = yield* connectCluster(connection);
        expect(transport.endpoint).toMatch(/^https:\/\//);
        const deployment = imageObjects.find((object) => object.kind === "Deployment");
        const live = yield* readObject({ transport, object: deployment! });
        expect((live as { kind?: string }).kind).toEqual("Deployment");
      }),
      { timeout: 300_000 },
    );

    test(
      "a pre-built image serves through its load balancer",
      Effect.gen(function* () {
        const { imageUrl } = yield* stack;
        expect(yield* getText(imageUrl!)).toContain("nginx");
      }),
      { timeout: 600_000 },
    );

    test.skipIf(REGISTRY === undefined)(
      "the effectful form serves, and reaches STACKIT through a binding",
      Effect.gen(function* () {
        const { effectUrl, zoneId } = yield* stack;
        expect(yield* getText(effectUrl!)).toEqual("effect server");
        const body = JSON.parse(yield* getText(`${effectUrl}/zone`)) as { zoneId?: string };
        expect(body.zoneId).toEqual(zoneId);
      }),
      { timeout: 600_000 },
    );

    test.skipIf(REGISTRY === undefined)(
      "the async form serves with its env",
      Effect.gen(function* () {
        const { asyncUrl } = yield* stack;
        expect(yield* getText(asyncUrl!)).toEqual(ASYNC_GREETING);
      }),
      { timeout: 600_000 },
    );
  },
);
