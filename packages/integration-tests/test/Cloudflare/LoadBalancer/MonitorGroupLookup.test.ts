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

const callerScript = `export default {
  async fetch() {
    return new Response("ok");
  },
};`;

// Monitor groups are Enterprise-only (`MonitorGroupsNotEnabled`, pinned in
// MonitorGroup.test.ts). Set CLOUDFLARE_LB_MONITOR_GROUPS_ENABLED=1 on an
// Enterprise account.
const monitorGroupsEnabled = !!process.env.CLOUDFLARE_LB_MONITOR_GROUPS_ENABLED;

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "MonitorGroupLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const monitor = yield* Cloudflare.LoadBalancer.Monitor("lookup-target-monitor", {
      type: "https",
      path: "/health",
      expectedCodes: "2xx",
    });
    const group = yield* Cloudflare.LoadBalancer.MonitorGroup("lookup-target", {
      members: [{ monitorId: monitor.monitorId }],
    });
    return {
      monitorGroupId: group.monitorGroupId.as<string>(),
      description: group.description.as<string>(),
    };
  }),
);

const target = beforeAll(
  monitorGroupsEnabled
    ? deploy(TargetStack)
    : Effect.succeed({ monitorGroupId: "", description: "" }),
);
afterAll.skipIf(!monitorGroupsEnabled || !!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider.skipIf(!monitorGroupsEnabled)(
  "a looked-up monitor group health-checks a new pool, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { monitorGroupId, description } = yield* target;

      const program = Effect.gen(function* () {
        const byDescription = Cloudflare.LoadBalancer.MonitorGroup.lookup({ description });
        const byId = Cloudflare.LoadBalancer.MonitorGroup.lookup({ monitorGroupId });
        const pool = yield* Cloudflare.LoadBalancer.Pool("monitor-group-lookup-pool", {
          origins: [{ name: "origin-1", address: "203.0.113.10" }],
          monitorGroup: byDescription.monitorGroupId,
        });
        return { poolId: pool.poolId, byIdDescription: byId.description };
      });
      const out = yield* stack.deploy(program);
      expect(out.byIdDescription).toBe(description);

      const plan = yield* stack.plan(program);
      expect(plan.resources["monitor-group-lookup-pool"].action).toBe("noop");

      yield* stack.destroy();
      const survivor = yield* loadBalancers.getMonitorGroup({ accountId, monitorGroupId });
      expect(survivor.description).toBe(description);
    }),
  { tags, timeout: 240_000 },
);

test.provider.skipIf(!monitorGroupsEnabled)(
  "a lookup of a missing monitor group fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const description = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("monitor-group-lookup-missing", {
            script: callerScript,
            env: {
              REF: Cloudflare.LoadBalancer.MonitorGroup.lookup({ description }).monitorGroupId,
            },
          }),
        ),
        ["LookupNotFoundError", description],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
