import * as Hetzner from "@alchemy.run/hetzner";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as zoneRrsets from "@distilled.cloud/hetzner/zone_rrsets";
import * as zones from "@distilled.cloud/hetzner/zones";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

const { test } = Test.make({ providers: Hetzner.providers() });

const tags = ["provider:hetzner", "provider:hetzner:zone", "provider:hetzner:recordset", "live"];

// The target belongs to another stack, as a lookup's target always should.
const target = () => Core.scratchStack({ providers: Hetzner.providers() }, "HetznerLookupTarget");

describe.concurrent("lookup", () => {
  test.provider(
    "a looked-up Zone holds a declared RecordSet and survives its destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const owner = target();
        yield* owner.destroy();
        const zone = yield* owner.deploy(Hetzner.Zone("LookupTarget", { ttl: 3600 }));

        const program = Hetzner.RecordSet("OnLookedUpZone", {
          zone: Hetzner.Zone.lookup({ name: zone.name }),
          name: "lookup",
          type: "TXT",
          records: [{ value: '"looked-up"' }],
        });
        const record = yield* stack.deploy(program);
        expect(record.zoneId).toEqual(zone.zoneId);
        const stored = yield* zoneRrsets.getZoneRrset({
          id_or_name: zone.name,
          rr_name: "lookup",
          rr_type: "TXT",
        });
        expect(stored.rrset.records.map((r) => r.value)).toEqual(['"looked-up"']);

        // A lookup re-resolves to the same Zone.
        const plan = yield* stack.plan(program);
        expect(plan.resources.OnLookedUpZone?.action).toEqual("noop");

        // Destroying the consumer removes the record set, never the Zone.
        yield* stack.destroy();
        const after = yield* zones.getZone({ id_or_name: zone.name });
        expect(after.zone.id).toEqual(zone.zoneId);
        const gone = yield* zoneRrsets
          .getZoneRrset({ id_or_name: zone.name, rr_name: "lookup", rr_type: "TXT" })
          .pipe(
            Effect.as("found" as const),
            Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          );
        expect(gone).toEqual("gone");

        yield* owner.destroy();
      }),
    { tags, timeout: 180_000 },
  );

  test.provider(
    "a lookup of a resource that doesn't exist fails the plan",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const owner = target();
        yield* owner.destroy();
        // Record sets are looked up in a zone that exists, so only the
        // record set itself is missing.
        const zone = yield* owner.deploy(Hetzner.Zone("LookupMissingTarget", { ttl: 3600 }));
        const missing = `alchemy-missing-${zone.zoneId}`;

        const lookups = {
          Network: Hetzner.Network.lookup({ name: missing }),
          SshKey: Hetzner.SshKey.lookup({ name: missing }),
          Volume: Hetzner.Volume.lookup({ name: missing }),
          Firewall: Hetzner.Firewall.lookup({ name: missing }),
          Certificate: Hetzner.Certificate.lookup({ name: missing }),
          FloatingIp: Hetzner.FloatingIp.lookup({ name: missing }),
          PrimaryIp: Hetzner.PrimaryIp.lookup({ name: missing }),
          PlacementGroup: Hetzner.PlacementGroup.lookup({ name: missing }),
          Server: Hetzner.Server.lookup({ name: missing }),
          LoadBalancer: Hetzner.LoadBalancer.lookup({ name: missing }),
          Zone: Hetzner.Zone.lookup({ name: `${missing}.com` }),
          RecordSet: Hetzner.RecordSet.lookup({ zone: zone.name, name: "missing", type: "TXT" }),
          Image: Hetzner.Image.lookup({ id: 999_999_999 }),
        } as unknown as Record<string, Output.Output<unknown>>;

        const mismatches: Record<string, string> = {};
        for (const [id, lookup] of Object.entries(lookups)) {
          const exit = yield* Effect.exit(
            stack.plan(
              Hetzner.Network(id, {
                ipRange: "10.98.0.0/16",
                labels: { value: Output.interpolate`${lookup}` },
              }),
            ),
          );
          const pretty = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "plan succeeded";
          if (!pretty.includes("LookupNotFoundError")) {
            mismatches[id] = pretty.split("\n")[0]!.slice(0, 300);
          }
        }
        expect(mismatches).toEqual({});

        yield* owner.destroy();
      }),
    { tags, timeout: 180_000 },
  );
});
