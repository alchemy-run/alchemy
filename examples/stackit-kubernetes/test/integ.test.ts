import { describe, expect } from "bun:test";
import * as Kubernetes from "@alchemy.run/kubernetes";
import * as Stackit from "@alchemy.run/stackit";
import * as Test from "@alchemy.run/test/Bun";
import * as ske from "@distilled.cloud/stackit/ske";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Stackit.providers(), Kubernetes.providers()),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

// Out-of-band calls resolve the same profile the deploy uses.
const StackitCloud = Layer.mergeAll(Stackit.StackitAuth, Stackit.fromAuthProvider()).pipe(
  Layer.provideMerge(FetchHttpClient.layer),
);

// STACKIT's Go SDK allows 45 minutes for a cluster to come up, and 90 to go down.
const CLUSTER_TIMEOUT = 3 * 60 * 60 * 1000;

/** A `200`, once a fresh load balancer stops refusing connections. */
const getOk = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.timeout("20 seconds"),
    Effect.flatMap((response) =>
      response.status === 200 ? Effect.succeed(response) : Effect.fail(`HTTP ${response.status}`),
    ),
    Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 30 }),
  );

describe("stackit-kubernetes", () => {
  const stack = beforeAll(deploy(Stack), { timeout: CLUSTER_TIMEOUT });

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const deployed = yield* stack;
      yield* destroy(Stack);

      // A failed deploy returns nothing, but the destroy above still removes what it made.
      if (deployed === undefined) return;
      const { projectId, region, clusterName } = deployed;

      const cluster = yield* ske.getCluster({ projectId, region, clusterName }).pipe(
        Effect.as("found"),
        Effect.catchTag("NotFound", () => Effect.succeed("gone")),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (state) => state === "gone",
          times: 12,
        }),
        Effect.provide(StackitCloud),
      );
      expect(cluster).toEqual("gone");
    }),
    { timeout: CLUSTER_TIMEOUT },
  );

  test(
    "the cluster is healthy",
    Effect.gen(function* () {
      const { projectId, region, clusterName } = yield* stack;
      const cluster = yield* ske
        .getCluster({ projectId, region, clusterName })
        .pipe(Effect.provide(StackitCloud));
      expect(cluster.status?.aggregated).toEqual("STATE_HEALTHY");
    }),
    { timeout: 120_000 },
  );

  test(
    "the public image serves through its load balancer",
    Effect.gen(function* () {
      const { webUrl } = yield* stack;
      const response = yield* getOk(webUrl!);
      expect(yield* response.text).toContain("nginx");
    }),
    { timeout: 600_000 },
  );

  test(
    "the Effect program serves, and reads the zone through a binding",
    Effect.gen(function* () {
      const { apiUrl, zoneId } = yield* stack;
      const health = yield* getOk(apiUrl!);
      expect(yield* health.text).toEqual("ok");

      const response = yield* getOk(`${apiUrl}/zone`);
      expect((yield* response.json) as { zoneId: string }).toEqual({ zoneId });
    }),
    { timeout: 600_000 },
  );
});
