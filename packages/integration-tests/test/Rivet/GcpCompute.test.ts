import * as GCP from "@alchemy.run/gcp";
import * as Rivet from "@alchemy.run/rivet";
import * as RivetGCP from "@alchemy.run/rivet/GCP";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
import { CLASS_SECRET, ClassSecretConfig } from "./fixtures/class-secret.ts";
import { expectDurableStream } from "./fixtures/durable-stream-check.ts";
import {
  instances,
  metadataOf,
  rolloutMarkers,
  secretMembers,
  workerPools,
} from "./fixtures/gcp-checks.ts";
import { Cluster } from "./fixtures/gcp-compute/cluster.ts";
import { CounterLive } from "./fixtures/gcp-compute/counter-live.ts";
import Front from "./fixtures/gcp-compute/front.ts";
import { expectRustCounter, RustActors, rustTarget, type RustTarget } from "./fixtures/rust.ts";

const testOptions = { providers: Layer.mergeAll(GCP.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "RivetGcpComputeConformance", import.meta.url);

let baseUrl = "";
let rust: RustTarget;

// A Rust Durable Object on a pool of its own: two nodes, so a deploy that
// changes them rolls out one node at a time. `phase` changes their env.
const RustPool = (phase: string) =>
  RivetGCP.ComputeEnginePool("Rust", { replicas: 2, env: { ROLLOUT_PHASE: phase } }).pipe(
    Layer.provide(Cluster),
  );
const program = (phase: string) =>
  Effect.gen(function* () {
    const front = yield* Front;
    const actors = yield* RustActors().pipe(Effect.provide(RustPool(phase)));
    return { url: front.uri, rust: rustTarget(actors) };
  }).pipe(Effect.provide(CounterLive.pipe(Layer.provide(ClassSecretConfig))));
const accessor = "roles/secretmanager.secretAccessor";
/** Out-of-band reads run with the GCP credentials and project the stack deploys with. */
const gcp = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Core.withProviders(effect, testOptions, sharedStack.name);
// Tests that redeploy the Rust pool, or call it, never overlap.
const rustPool = { exclusive: "rivet-gcp-compute-rust" } as const;

// The engine conformance spec, run against Rivet Durable Objects on a
// control plane and a pool of nodes on Compute Engine, called from Cloud Run.
describe.skipIf(!!process.env.FAST)(
  "Rivet on GCP (Compute control plane, Compute pool)",
  { tags: ["provider:rivet", "provider:gcp", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        // NO_DESTROY keeps the stack between runs, so iterate on it.
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(program("1"));
        const url = out.url;
        rust = out.rust as RustTarget;
        expect(url).toBeTruthy();
        baseUrl = String(url).replace(/\/+$/, "");
        yield* waitForReady(baseUrl, { attempts: 40, base: "3 seconds" });
      }),
      { timeout: 1_200_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 900_000 });

    conformanceTests(test, { baseUrl: () => baseUrl, kind: "live" });
    test(
      "Durable Streams: the front appends to and reads a stream on its cloud's Services pool",
      Effect.suspend(() => expectDurableStream(baseUrl)),
      { timeout: 180_000 },
    );

    test(
      "a Rust Durable Object runs on a Compute Engine pool",
      Effect.gen(function* () {
        yield* expectRustCounter(rust, "gcpcompute-rust");
      }),
      { timeout: 300_000, ...rustPool },
    );

    test(
      "the control plane's token reaches the engines and every node from Secret Manager, never metadata",
      gcp(
        Effect.gen(function* () {
          // The engines: their startup script names the token's secret version.
          const engines = yield* instances(sharedStack, /rivetinstance\d+$/);
          expect(engines.length).toBeGreaterThan(0);
          for (const engine of engines) {
            const script = metadataOf(engine)["startup-script"] ?? "";
            expect(script).toMatch(
              /secretmanager\.googleapis\.com\/v1\/projects\/[^/]+\/secrets\/[^/]+\/versions\/\d+:access/,
            );
            expect(script).not.toMatch(/ADMIN_TOKEN='/);
          }
          // The nodes: no token in their env, its version in their secrets, and
          // their own account granted that secret alone.
          const nodes = yield* instances(sharedStack, /rustnode\d+$/);
          expect(nodes).toHaveLength(2);
          // The pool hosting the class that reads a secret as config.
          const defaults = yield* instances(sharedStack, /defaultnode\d+$/);
          expect(defaults.length).toBeGreaterThan(0);
          expect(JSON.stringify(defaults.map(metadataOf))).not.toContain(CLASS_SECRET);
          for (const node of [...nodes, ...defaults]) {
            const metadata = metadataOf(node);
            expect(metadata["rivet-node-env"]).not.toMatch(/^RIVET_TOKEN=/m);
            // Secrets the classes read as config come from Secret Manager too.
            expect(metadata["rivet-node-secrets"]).toMatch(/^RIVET_SECRET_ENV=projects\//m);
            const version = /^RIVET_TOKEN=(.+)$/m.exec(metadata["rivet-node-secrets"] ?? "")?.[1];
            expect(version).toMatch(/^projects\/[^/]+\/secrets\/[^/]+\/versions\/\d+$/);
            const email = node.serviceAccounts?.[0]?.email;
            expect(
              yield* secretMembers(version!.replace(/\/versions\/\d+$/, ""), accessor),
            ).toEqual([`serviceAccount:${email}`]);
          }
          // Rivet Services on Cloud Run: the token by reference only.
          const [services] = yield* workerPools(sharedStack, /servicesnodes$/);
          const env = services?.template?.containers?.[0]?.env ?? [];
          const token = env.find((entry) => entry.name === "RIVET_TOKEN");
          expect(token?.value).toBeUndefined();
          expect(token?.valueSource?.secretKeyRef?.secret).toBeTruthy();
        }),
      ),
      { timeout: 120_000 },
    );

    test(
      "a deploy restarts the nodes one at a time, each once the one before it is back",
      gcp(
        Effect.gen(function* () {
          const before = (yield* instances(sharedStack, /rustnode\d+$/)).map(
            (node) => metadataOf(node)["rivet-node-rollout"],
          );
          const out = yield* sharedStack.deploy(program("2"));
          rust = out.rust as RustTarget;
          const nodes = yield* instances(sharedStack, /rustnode\d+$/);
          const metadata = nodes.map(metadataOf);
          const rollout = metadata[0]!["rivet-node-rollout"]!;
          expect(before).not.toContain(rollout);
          expect(metadata.map((values) => values["rivet-node-rollout"])).toEqual([
            rollout,
            rollout,
          ]);
          const bucket = /\/b\/([^/]+)\/o\/node\.tar/.exec(metadata[0]!["startup-script"]!)![1]!;
          // Each node writes its marker once it runs the new program and the
          // control plane lists the pool whole again.
          const markers = yield* rolloutMarkers(bucket, rollout).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (found) => found.length === 2,
              times: 48,
            }),
          );
          const [first, second] = [...markers].sort((a, b) => a.name.localeCompare(b.name));
          expect(first!.name).toBe(`rollout/${rollout}/0`);
          expect(second!.name).toBe(`rollout/${rollout}/1`);
          // Node 1 restarted only after node 0 was back.
          expect(Date.parse(second!.created)).toBeGreaterThan(Date.parse(first!.created));
          yield* expectRustCounter(rust, "gcpcompute-rust-rollout");
        }),
      ),
      { timeout: 900_000, ...rustPool },
    );
  },
);
