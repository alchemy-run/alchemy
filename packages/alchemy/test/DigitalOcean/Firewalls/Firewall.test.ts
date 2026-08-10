import * as DigitalOcean from "@/DigitalOcean";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { firewallsGet } from "@distilled.cloud/digitalocean/firewalls";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasDigitalOceanCreds = !!(
  process.env.DIGITALOCEAN_TOKEN || process.env.DIGITALOCEAN_ACCESS_TOKEN
);

// Out-of-band verification context: raw distilled calls, credentials from
// env — independent of the provider layer under test.
const outOfBand = Effect.provide(
  Layer.mergeAll(DigitalOcean.CredentialsFromEnv, FetchHttpClient.layer),
);

const FIREWALL_NAME = "alchemy-test-firewall";

const SSH_ONLY: DigitalOcean.FirewallInboundRule[] = [
  { protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0", "::/0"] },
];

const WEB_RULES: DigitalOcean.FirewallInboundRule[] = [
  { protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0", "::/0"] },
  { protocol: "tcp", ports: "80", addresses: ["0.0.0.0/0", "::/0"] },
  { protocol: "tcp", ports: "443", addresses: ["0.0.0.0/0", "::/0"] },
];

test.provider.skipIf(!hasDigitalOceanCreds)(
  "firewall lifecycle: create, widen rules in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DigitalOcean.Firewall("TestFirewall", {
            name: FIREWALL_NAME,
            tags: ["alchemy-test"],
            inboundRules: SSH_ONLY,
          });
        }),
      );
      expect(created.name).toEqual(FIREWALL_NAME);
      expect(created.status).toEqual("succeeded");
      expect(created.inboundRules).toHaveLength(1);
      // Omitted outboundRules defaulted to allow-all (tcp, udp, icmp).
      expect(created.outboundRules).toHaveLength(3);

      // Out-of-band: the firewall exists in the real account.
      const remote = yield* firewallsGet({
        firewall_id: created.firewallId,
      }).pipe(outOfBand);
      expect(remote.firewall?.name).toEqual(FIREWALL_NAME);
      expect(remote.firewall?.inbound_rules ?? []).toHaveLength(1);

      // Same logical id, wider rules — everything updates in place, so the
      // physical firewall id must survive.
      const widened = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DigitalOcean.Firewall("TestFirewall", {
            name: FIREWALL_NAME,
            tags: ["alchemy-test"],
            inboundRules: WEB_RULES,
          });
        }),
      );
      expect(widened.firewallId).toEqual(created.firewallId);
      expect(widened.inboundRules).toHaveLength(3);
      expect(widened.inboundRules.map((r) => r.ports).sort()).toEqual([
        "22",
        "443",
        "80",
      ]);

      // list() hydrates the exact read/Attributes shape.
      const provider = yield* Provider.findProvider(DigitalOcean.Firewall);
      const all = yield* provider.list();
      expect(
        all.find((f) => f.firewallId === created.firewallId)?.inboundRules,
      ).toHaveLength(3);

      yield* stack.destroy();

      // Typed wait-until-gone: the firewall must actually be deleted.
      const gone = yield* firewallsGet({
        firewall_id: created.firewallId,
      }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        outOfBand,
      );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { timeout: 300_000 },
);
