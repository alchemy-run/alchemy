import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expectDeployFails, missingName } from "../../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:tunnel", "live"];

const ingressHost = "tunnel-lookup-test.internal";

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "TunnelLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const tunnel = yield* Cloudflare.Tunnel.Tunnel("lookup-target", { configSrc: "cloudflare" });
    return {
      name: tunnel.tunnelName.as<string>(),
      tunnelId: tunnel.tunnelId.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up tunnel takes a configuration, by name and by id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { name, tunnelId } = yield* target;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.Tunnel.Tunnel.lookup({ name });
        const byId = Cloudflare.Tunnel.Tunnel.lookup({ tunnelId });
        yield* Cloudflare.Tunnel.Configuration("tunnel-lookup-config", {
          tunnelId: byName.tunnelId,
          ingress: [
            { hostname: ingressHost, service: "http://localhost:8080" },
            { service: "http_status:404" },
          ],
        });
        return { tunnelId: byName.tunnelId, nameById: byId.tunnelName, token: byId.token };
      });
      const out = yield* stack.deploy(program);
      expect(out.tunnelId).toBe(tunnelId);
      expect(out.nameById).toBe(name);
      expect(Redacted.value(out.token).length).toBeGreaterThan(0);

      // The configuration landed on the looked-up tunnel.
      const config = yield* zeroTrust.getTunnelCloudflaredConfiguration({ accountId, tunnelId });
      expect(config.config?.ingress?.[0]?.hostname).toBe(ingressHost);

      // A lookup re-resolves to the same tunnel, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["tunnel-lookup-config"].action).toBe("noop");

      // Destroying the stack that looked it up leaves the tunnel alone.
      yield* stack.destroy();
      const survivor = yield* zeroTrust.getTunnelCloudflared({ accountId, tunnelId });
      expect(survivor.name).toBe(name);
      expect(survivor.deletedAt ?? undefined).toBeUndefined();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a lookup of a missing tunnel fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Tunnel.Configuration("tunnel-lookup-missing", {
            tunnelId: Cloudflare.Tunnel.Tunnel.lookup({ name }).tunnelId,
            ingress: [{ service: "http_status:404" }],
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a tunnel this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => Cloudflare.Tunnel.Tunnel("lookup-managed");
      const { tunnelName } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Tunnel.Configuration("tunnel-lookup-managed-config", {
              tunnelId: Cloudflare.Tunnel.Tunnel.lookup({ name: tunnelName }).tunnelId,
              ingress: [{ service: "http_status:404" }],
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
