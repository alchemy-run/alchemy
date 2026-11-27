import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as IAM from "@alchemy.run/gcp/IAM";
import * as SecretManager from "@alchemy.run/gcp/SecretManager";
import * as Rivet from "@alchemy.run/rivet";
import * as RivetGCP from "@alchemy.run/rivet/GCP";
import { withConnection } from "@alchemy.run/rivet/internal/Connection";
import * as RivetNode from "@alchemy.run/rivet/Node";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Pools from "@distilled.cloud/rivet/pools";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
import { CLASS_SECRET, ClassSecretConfig } from "./fixtures/class-secret.ts";
import { Counter } from "./fixtures/counter-declaration.ts";
import { secretMembers, workerPools } from "./fixtures/gcp-checks.ts";
import { Cluster } from "./fixtures/gcp/cluster.ts";
import { CounterLive } from "./fixtures/gcp/counter-live.ts";
import Front from "./fixtures/gcp/front.ts";
import { PrivateCluster, PrivateServices } from "./fixtures/gcp/private-cluster.ts";
import { PrivateCounterLive } from "./fixtures/gcp/private-counter-live.ts";
import { expectRustCounter, RustActors, rustTarget, type RustTarget } from "./fixtures/rust.ts";

const testOptions = { providers: Layer.mergeAll(GCP.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "RivetGcpConformance", import.meta.url);

let baseUrl = "";
let rust: RustTarget;

// A Rust Durable Object on a pool of its own, reading a secret of the
// stack's besides the control plane's token, and run as a service account
// of the stack's own when `named` is set.
const program = (named: boolean) =>
  Effect.gen(function* () {
    const front = yield* Front;
    const extra = yield* SecretManager.Secret("RustExtra", { value: "extra-value" });
    const account = named
      ? (yield* IAM.ServiceAccount("RustNodeAccount", { displayName: "Rivet Rust nodes" })).email
      : undefined;
    const actors = yield* RustActors().pipe(
      Effect.provide(
        RivetGCP.CloudRunPool("Rust", {
          secrets: { EXTRA_SECRET: extra.version.pipe(Output.map((v) => v ?? "")) },
          ...(account === undefined ? {} : { serviceAccount: account }),
        }).pipe(Layer.provide(Cluster)),
      ),
    );
    return { url: front.uri, rust: rustTarget(actors), extra: extra.name, account };
  }).pipe(Effect.provide(CounterLive.pipe(Layer.provide(ClassSecretConfig))));
const accessor = "roles/secretmanager.secretAccessor";
/** Out-of-band reads run with the GCP credentials and project the stack deploys with. */
const gcp = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Core.withProviders(effect, testOptions, sharedStack.name);
// Tests that redeploy the Rust pool, or call it, never overlap.
const rustPool = { exclusive: "rivet-gcp-run-rust" } as const;

/** The Rust pool's nodes: the account they run as and their env. */
const rustNodes = Effect.fn(function* () {
  const [pool] = yield* workerPools(sharedStack, /rustnodes$/);
  expect(pool).toBeDefined();
  return {
    account: pool!.template?.serviceAccount ?? "",
    env: pool!.template?.containers?.[0]?.env ?? [],
  };
});
const secretOf = (
  project: string,
  env: ReadonlyArray<{ name?: string; valueSource?: { secretKeyRef?: { secret?: string } } }>,
  name: string,
) => {
  const secret = env.find((entry) => entry.name === name)?.valueSource?.secretKeyRef?.secret ?? "";
  // A secret of the stack's project is referenced by its id alone.
  return secret.startsWith("projects/") ? secret : `projects/${project}/secrets/${secret}`;
};

// The engine conformance spec, run against Rivet Durable Objects on a
// control plane on Compute Engine and a Cloud Run worker pool, called from Cloud Run.
describe.skipIf(!!process.env.FAST)(
  "Rivet on GCP (Compute control plane, Cloud Run worker pool)",
  { tags: ["provider:rivet", "provider:gcp", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        // NO_DESTROY keeps the stack between runs, so iterate on it.
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(program(false));
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
      "a Rust Durable Object runs on a Cloud Run worker pool",
      Effect.gen(function* () {
        yield* expectRustCounter(rust, "gcp-rust");
      }),
      { timeout: 300_000, ...rustPool },
    );

    test(
      "the token and the pool's secrets reach the nodes by reference, granted to the worker pool's account",
      gcp(
        Effect.gen(function* () {
          const { project } = yield* GcpEnvironment.current;
          const { account, env } = yield* rustNodes();
          // The pool hosting the class that reads a secret as config.
          const [defaults] = yield* workerPools(sharedStack, /defaultnodes$/);
          expect(JSON.stringify(defaults?.template)).not.toContain(CLASS_SECRET);
          expect(
            defaults?.template?.containers?.[0]?.env?.find((e) => e.name === "RIVET_SECRET_ENV")
              ?.valueSource?.secretKeyRef,
          ).toBeDefined();
          // Neither value is in the worker pool's configuration.
          for (const name of ["RIVET_TOKEN", "EXTRA_SECRET"]) {
            const entry = env.find((e) => e.name === name);
            expect(entry?.value).toBeUndefined();
            expect(yield* secretMembers(secretOf(project, env, name), accessor)).toContain(
              `serviceAccount:${account}`,
            );
          }
        }),
      ),
      { timeout: 120_000, ...rustPool },
    );

    test(
      "a named service account runs the nodes and is granted every secret",
      gcp(
        Effect.gen(function* () {
          const out = yield* sharedStack.deploy(program(true));
          rust = out.rust as RustTarget;
          const { project } = yield* GcpEnvironment.current;
          const { account, env } = yield* rustNodes();
          expect(account).toBe(out.account);
          for (const name of ["RIVET_TOKEN", "EXTRA_SECRET"]) {
            expect(yield* secretMembers(secretOf(project, env, name), accessor)).toContain(
              `serviceAccount:${out.account}`,
            );
          }
          yield* expectRustCounter(rust, "gcp-rust-named");
        }),
      ),
      { timeout: 600_000, ...rustPool },
    );
  },
);

// A control plane with a private address on a GCP network, given to
// Rivet.ControlPlane: a Cloud Run pool joins the network and its nodes
// connect privately, and a pool that can't join connects to the public
// endpoint.
const privateStack = Core.scratchStack(testOptions, "RivetGcpPrivate", import.meta.url);
let reached: {
  endpoint: string;
  nodeEndpoint: string;
  token: Redacted.Redacted<string>;
  namespace: string;
};
/** A worker pool's plain environment, by name. */
const envOf = (
  pool:
    | { template?: { containers?: Array<{ env?: Array<{ name?: string; value?: string }> }> } }
    | undefined,
) =>
  Object.fromEntries(
    (pool?.template?.containers?.[0]?.env ?? []).map((entry) => [entry.name ?? "", entry.value]),
  );

describe.skipIf(!!process.env.FAST)(
  "Rivet on GCP (a control plane with a private address)",
  { tags: ["provider:rivet", "provider:gcp", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        if (!process.env.NO_DESTROY) yield* privateStack.destroy();
        reached = (yield* privateStack.deploy(
          Effect.gen(function* () {
            yield* Counter;
            yield* Rivet.Services;
            const cluster = yield* Rivet.Cluster;
            return {
              endpoint: cluster.endpoint,
              nodeEndpoint: cluster.nodeEndpoint,
              token: cluster.token,
              namespace: cluster.namespace,
            };
          }).pipe(
            Effect.provide(
              Layer.mergeAll(PrivateCounterLive, PrivateServices).pipe(
                Layer.provideMerge(PrivateCluster),
              ),
            ),
          ),
        )) as typeof reached;
      }),
      { timeout: 1_200_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(privateStack.destroy(), { timeout: 900_000 });

    test(
      "a Cloud Run pool joins the control plane's network, and its nodes connect to the private address",
      Effect.gen(function* () {
        const [pool] = yield* Core.withProviders(
          workerPools(privateStack, /privatenodes$/),
          testOptions,
          privateStack.name,
        );
        expect(pool?.template?.vpcAccess?.networkInterfaces).toEqual([
          { network: "default", subnetwork: "default" },
        ]);
        const env = envOf(pool);
        expect(env.RIVET_ENDPOINT).toBe(reached.nodeEndpoint);
        expect(reached.nodeEndpoint).not.toBe(reached.endpoint);
        // The nodes connect only through the private address: a call reaches them.
        const counters = yield* RivetNode.connect(Counter, {
          endpoint: reached.endpoint,
          token: reached.token,
          namespace: reached.namespace,
          pool: env.RIVET_POOL!,
        });
        // The counter's methods ask for the RuntimeContext of an Alchemy
        // runtime, which a gateway call never reads.
        const increment = counters.getByName("private").increment() as unknown as Effect.Effect<
          number,
          unknown
        >;
        const first = yield* increment.pipe(
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 36 }),
        );
        expect(yield* increment).toBe(first + 1);
      }),
      { timeout: 300_000 },
    );

    test(
      "a pool that can't join the control plane's network connects to its public endpoint",
      Effect.gen(function* () {
        const [pool] = yield* Core.withProviders(
          workerPools(privateStack, /privateservicesnodes$/),
          testOptions,
          privateStack.name,
        );
        expect(pool?.template?.vpcAccess).toBeUndefined();
        expect(envOf(pool).RIVET_ENDPOINT).toBe(reached.endpoint);
        // Its node reaches the control plane and joins the services pool.
        const nodes = yield* Pools.listPoolNodes({
          namespace: reached.namespace,
          pool: Rivet.SERVICES_POOL,
        }).pipe(
          Effect.map((page) => page.nodes),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (nodes) => nodes.length > 0,
            times: 36,
          }),
          withConnection({ endpoint: reached.endpoint, token: reached.token }),
        );
        expect(nodes.length).toBeGreaterThan(0);
      }),
      { timeout: 300_000 },
    );
  },
);
