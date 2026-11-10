import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:tunnel", "live"];

// The route lives in the target's own virtual network, which is per stage,
// so a fixed CIDR never collides with another run.
const NETWORK = "10.98.1.0/24";

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "VirtualNetworkLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const vnet = yield* Cloudflare.Tunnel.VirtualNetwork("lookup-target", {
      comment: "lookup target",
    });
    return {
      virtualNetworkId: vnet.virtualNetworkId.as<string>(),
      name: vnet.name.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a route targets a looked-up virtual network, by name and by id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { virtualNetworkId, name } = yield* target;

      const program = Effect.gen(function* () {
        const vnet = Cloudflare.Tunnel.VirtualNetwork.lookup({ name });
        const byId = Cloudflare.Tunnel.VirtualNetwork.lookup({ virtualNetworkId });
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("vnet-lookup-tunnel");
        const route = yield* Cloudflare.Tunnel.Route("vnet-lookup-route", {
          tunnelId: tunnel.tunnelId,
          network: NETWORK,
          virtualNetworkId: vnet.virtualNetworkId,
        });
        return { routeId: route.routeId, nameById: byId.name };
      });
      const out = yield* stack.deploy(program);
      expect(out.nameById).toBe(name);

      const route = yield* zeroTrust.getNetworkRoute({ accountId, routeId: out.routeId });
      expect(route.virtualNetworkId).toBe(virtualNetworkId);

      // A lookup re-resolves to the same network, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["vnet-lookup-route"].action).toBe("noop");

      // Destroy removes the route and leaves the virtual network alone.
      yield* stack.destroy();
      const survivor = yield* zeroTrust.getNetworkVirtualNetwork({ accountId, virtualNetworkId });
      expect(survivor.name).toBe(name);
      expect(survivor.deletedAt ?? undefined).toBeUndefined();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a lookup of a missing virtual network fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            const tunnel = yield* Cloudflare.Tunnel.Tunnel("vnet-lookup-missing-tunnel");
            yield* Cloudflare.Tunnel.Route("vnet-lookup-missing-route", {
              tunnelId: tunnel.tunnelId,
              network: NETWORK,
              virtualNetworkId: Cloudflare.Tunnel.VirtualNetwork.lookup({ name }).virtualNetworkId,
            });
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a virtual network this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => Cloudflare.Tunnel.VirtualNetwork("lookup-managed", {});
      const { name } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            const tunnel = yield* Cloudflare.Tunnel.Tunnel("vnet-lookup-managed-tunnel");
            yield* Cloudflare.Tunnel.Route("vnet-lookup-managed-route", {
              tunnelId: tunnel.tunnelId,
              network: NETWORK,
              virtualNetworkId: Cloudflare.Tunnel.VirtualNetwork.lookup({ name }).virtualNetworkId,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
