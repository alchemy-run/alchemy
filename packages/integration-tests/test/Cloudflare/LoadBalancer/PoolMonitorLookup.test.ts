import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as loadBalancers from "@distilled.cloud/cloudflare/load-balancers";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:loadbalancer", "live"];

// Load Balancing is a paid add-on the testing account doesn't have (pool and
// monitor creates fail with `PoolAccessFailed`), so the tests that create one
// run only with CLOUDFLARE_LB_ENABLED=1, like the Pool and Monitor suites. A
// missing lookup fails at plan time, before anything is created, so that
// test always runs.
const lbEnabled = !!process.env.CLOUDFLARE_LB_ENABLED;

// The monitor and pool belong to another stack, as a lookup's target always
// should.
const TargetStack = Alchemy.Stack(
  "LoadBalancerLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const monitor = yield* Cloudflare.LoadBalancer.Monitor("lookup-monitor", {});
    const pool = yield* Cloudflare.LoadBalancer.Pool("lookup-pool", {
      origins: [{ name: "origin-1", address: "203.0.113.10" }],
    });
    return {
      monitorId: monitor.monitorId.as<string>(),
      description: monitor.description.as<string>(),
      poolId: pool.poolId.as<string>(),
      poolName: pool.name.as<string>(),
    };
  }),
);

const target = beforeAll(
  lbEnabled
    ? deploy(TargetStack)
    : Effect.succeed({ monitorId: "", description: "", poolId: "", poolName: "" }),
);
afterAll.skipIf(!lbEnabled || !!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider.skipIf(!lbEnabled)(
  "a new pool uses a looked-up monitor, and a looked-up pool resolves by name and id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { monitorId, description, poolId, poolName } = yield* target;

      const program = Effect.gen(function* () {
        const monitor = Cloudflare.LoadBalancer.Monitor.lookup({ description });
        const pool = yield* Cloudflare.LoadBalancer.Pool("lookup-consumer-pool", {
          origins: [{ name: "origin-1", address: "203.0.113.20" }],
          monitor: monitor.monitorId,
        });
        const byName = Cloudflare.LoadBalancer.Pool.lookup({ name: poolName });
        const byId = Cloudflare.LoadBalancer.Monitor.lookup({ monitorId });
        return {
          consumerPoolId: pool.poolId,
          poolId: byName.poolId,
          descriptionById: byId.description,
        };
      });
      const out = yield* stack.deploy(program);
      expect(out.poolId).toBe(poolId);
      expect(out.descriptionById).toBe(description);

      // The new pool health-checks with the looked-up monitor.
      const consumer = yield* loadBalancers.getPool({ accountId, poolId: out.consumerPoolId });
      expect(consumer.monitor).toBe(monitorId);

      // Lookups re-resolve to the same objects, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["lookup-consumer-pool"].action).toBe("noop");

      // Destroy removes the new pool and leaves the targets alone.
      yield* stack.destroy();
      expect((yield* loadBalancers.getMonitor({ accountId, monitorId })).description).toBe(
        description,
      );
      expect((yield* loadBalancers.getPool({ accountId, poolId })).name).toBe(poolName);
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a lookup of a missing monitor fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const description = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.LoadBalancer.Pool("lookup-missing-pool", {
            origins: [{ name: "origin-1", address: "203.0.113.30" }],
            monitor: Cloudflare.LoadBalancer.Monitor.lookup({ description }).monitorId,
          }),
        ),
        ["LookupNotFoundError", description],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider.skipIf(!lbEnabled)(
  "a lookup of a monitor this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => Cloudflare.LoadBalancer.Monitor("lookup-managed", {});
      const { description } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.LoadBalancer.Pool("lookup-managed-pool", {
              origins: [{ name: "origin-1", address: "203.0.113.40" }],
              monitor: Cloudflare.LoadBalancer.Monitor.lookup({ description }).monitorId,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
