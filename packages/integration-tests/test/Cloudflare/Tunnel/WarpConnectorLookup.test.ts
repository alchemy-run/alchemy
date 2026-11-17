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

// The route lives in its own virtual network, so its CIDR can't collide
// with another suite's routes in the account's default network.
const NETWORK = "10.97.1.0/24";

const callerScript = `export default {
  async fetch() {
    return new Response("ok");
  },
};`;

// The target belongs to another stack, as a lookup's target always should.
// It is declared without props, which must work: every prop is optional.
const TargetStack = Alchemy.Stack(
  "WarpConnectorLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const connector = yield* Cloudflare.Tunnel.WarpConnector("lookup-target");
    return { tunnelId: connector.tunnelId.as<string>(), name: connector.name.as<string>() };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up WARP connector carries a new route, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { tunnelId, name } = yield* target;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.Tunnel.WarpConnector.lookup({ name });
        const byId = Cloudflare.Tunnel.WarpConnector.lookup({ tunnelId });
        const vnet = yield* Cloudflare.Tunnel.VirtualNetwork("warp-lookup-vnet");
        const route = yield* Cloudflare.Tunnel.Route("warp-lookup-route", {
          tunnelId: byName.tunnelId,
          network: NETWORK,
          virtualNetworkId: vnet.virtualNetworkId,
        });
        return { routeTunnelId: route.tunnelId, byIdName: byId.name };
      });
      const out = yield* stack.deploy(program);
      expect(out.routeTunnelId).toBe(tunnelId);
      expect(out.byIdName).toBe(name);

      // A lookup re-resolves to the same connector, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["warp-lookup-route"].action).toBe("noop");

      // Destroying the stack removes its route but leaves the connector.
      yield* stack.destroy();
      const survivor = yield* zeroTrust.getTunnelWarpConnector({ accountId, tunnelId });
      expect(survivor.name).toBe(name);
      expect(survivor.deletedAt ?? undefined).toBeUndefined();
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing WARP connector fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("warp-lookup-missing", {
            script: callerScript,
            env: { REF: Cloudflare.Tunnel.WarpConnector.lookup({ name }).tunnelId },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a WARP connector this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => Cloudflare.Tunnel.WarpConnector("lookup-managed");
      const { tunnelId } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("warp-lookup-managed-caller", {
              script: callerScript,
              env: { REF: Cloudflare.Tunnel.WarpConnector.lookup({ tunnelId }).tunnelId },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
