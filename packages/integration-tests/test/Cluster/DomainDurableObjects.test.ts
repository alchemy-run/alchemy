import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { CloudflareApiLive } from "@alchemy.run/cloudflare/Providers";
import * as Cluster from "@alchemy.run/effect-cluster";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { conformance, waitForReady } from "../Domain/conformance/conformance.ts";
import DomainDurableObjectsFront from "./fixtures/domain-cloudflare/front.ts";
import { ENTITY } from "./fixtures/domain-cloudflare/live.ts";

const testOptions = {
  providers: Layer.mergeAll(Cloudflare.providers(), Cluster.providers()),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
const stack = Core.scratchStack(testOptions, "ClusterDomainDurableObjects", import.meta.url);

let baseUrl = "";
/** When this run deployed: the log query below reads only what it wrote. */
let deployedAt = 0;

/** Workers Logs events since the deploy whose message carries `text`. */
const logEvents = (accountId: string, text: string) =>
  // Re-evaluate the timeframe per poll: rows are keyed by ingestion time.
  Effect.suspend(() =>
    workers.queryObservabilityTelemetry({
      accountId,
      queryId: "adhoc-cluster-domain-durable-objects",
      view: "events",
      timeframe: { from: deployedAt, to: Date.now() },
      limit: 10,
      parameters: {
        filters: [{ key: "$metadata.message", operation: "includes", type: "string", value: text }],
      },
    }),
  ).pipe(Effect.map((response) => response.events?.events ?? []));

// The Domain conformance model on Effect Cluster entities in a Durable
// Object pool: each instance keeps its rows in its own object, and the pool
// has no database. Called from a Worker through the gateway.
describe.skipIf(!!process.env.FAST)(
  "Domain on Effect Cluster (Durable Objects)",
  { tags: ["provider:cluster", "provider:cluster:domain", "provider:cloudflare", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        if (!process.env.NO_DESTROY) yield* stack.destroy();
        deployedAt = Date.now();
        const { url } = yield* stack.deploy(
          Effect.gen(function* () {
            const front = yield* DomainDurableObjectsFront;
            return { url: front.url.as<string>() };
          }),
        );
        expect(url).toBeTruthy();
        yield* waitForReady(url!);
        baseUrl = url!;
      }),
      { timeout: 600_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(stack.destroy(), { timeout: 300_000 });

    conformance({ test, url: Effect.sync(() => baseUrl), kind: "live" });

    // Retention sweeps the rows of a shared database. The pool keeps them in
    // each instance's own object, so its runners have nothing to sweep, and
    // must not try: every object that starts would log the failure.
    test(
      "the pool's runners run no retention sweep",
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        // Commands start the objects that hold the counters, the view and the saga.
        for (const id of ["a", "b", "c"]) {
          const response = yield* client.get(`${baseUrl}/increment/sweep-${id}-${deployedAt}?by=2`);
          expect(yield* response.json).toMatchObject({ accepted: 2 });
        }
        const { accountId } = yield* yield* CloudflareEnvironment;
        // Give the objects' logs time to arrive.
        yield* Effect.sleep("45 seconds");
        const failed = yield* logEvents(
          accountId,
          `Cluster.Entity '${ENTITY}': retention sweep failed`,
        );
        expect(failed).toEqual([]);
      }).pipe(Effect.provide(CloudflareApiLive()), Effect.scoped),
      { timeout: 120_000 },
    );
  },
);
