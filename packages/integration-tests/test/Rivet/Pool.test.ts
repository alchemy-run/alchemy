import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import * as RivetDocker from "@alchemy.run/rivet/Docker";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as RivetApi from "@distilled.cloud/rivet";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ensureDockerSwarm } from "../Docker/Runtime.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Docker.providers(), Rivet.providers()),
});

// One local control plane per suite, on a port of its own.
const PORT = 16430;
const Cluster = RivetDocker.ControlPlane("Rivet", { port: PORT });

const deployPool = (props: { drainOnVersionUpgrade?: boolean; actorEvictionPeriod?: number }) =>
  Effect.gen(function* () {
    const cluster = yield* Rivet.Cluster;
    const pool = yield* Rivet.Pool("Nodes", {
      endpoint: cluster.endpoint,
      token: cluster.token,
      namespace: cluster.namespace,
      ...props,
    });
    return {
      name: pool.name,
      namespace: pool.namespace,
      drainOnVersionUpgrade: pool.drainOnVersionUpgrade,
      token: cluster.token,
    };
  }).pipe(Effect.provide(Cluster));

/** Read the pool straight from the control plane. */
const observe = (deployed: { name: string; namespace: string; token: unknown }) =>
  RivetApi.pools.getPool({ pool: deployed.name, namespace: deployed.namespace }).pipe(
    Effect.map((res) => res.pool),
    Effect.catchTag("PoolNotFound", () => Effect.undefined),
    Effect.provide(
      RivetApi.credentials({
        token: deployed.token as Redacted.Redacted<string>,
        endpoint: `http://localhost:${PORT}`,
      }),
    ),
  );

describe("Rivet.Pool", { tags: ["provider:rivet", "provider:rivet:pool", "local"] }, () => {
  test.provider(
    "creates, updates in place and deletes a pool",
    (stack) =>
      Effect.gen(function* () {
        // The control plane runs as a swarm service.
        yield* ensureDockerSwarm;
        yield* stack.destroy();

        const created = yield* stack.deploy(deployPool({}));
        expect(Redacted.isRedacted(created.token)).toBe(true);
        const first = yield* observe(created);
        expect(first?.name).toBe(created.name);
        expect(first?.drain_on_version_upgrade).toBe(false);
        // Ownership tags ride in the pool's metadata.
        expect((first?.metadata as { tags?: Record<string, string> })?.tags).toBeDefined();

        const updated = yield* stack.deploy(
          deployPool({ drainOnVersionUpgrade: true, actorEvictionPeriod: 30 }),
        );
        expect(updated.name).toBe(created.name);
        const second = yield* observe(updated);
        expect(second?.drain_on_version_upgrade).toBe(true);
        expect(second?.actor_eviction_period).toBe(30);

        // A redeploy with nothing changed plans no update.
        const plan = yield* stack.plan(
          deployPool({ drainOnVersionUpgrade: true, actorEvictionPeriod: 30 }),
        );
        expect(
          Object.values(plan.resources).filter((r: { action: string }) => r.action !== "noop"),
        ).toEqual([]);

        // The pool is deleted before the control plane it lives on.
        const poolGone = observe(updated);
        yield* stack.deploy(Effect.provide(Effect.void, Cluster));
        expect(yield* poolGone).toBeUndefined();

        yield* stack.destroy();
      }),
    { timeout: 240_000 },
  );
});
