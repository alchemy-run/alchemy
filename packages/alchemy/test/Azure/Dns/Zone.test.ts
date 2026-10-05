import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { getZone, logLevel, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const groupOnly = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  return { group };
});

const program = (props: { name?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const { group } = yield* groupOnly;
    const zone = yield* Azure.Dns.Zone("Zone", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      tags: props.tags,
    });
    return { group, zone };
  });

// Cost: $0.50/zone-month prorated — fractions of a cent. ~1-2 minutes.
test.provider(
  "create, update tags, replace, and delete a DNS zone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create with the generated name.
      const { group, zone } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(zone.zoneName).toMatch(/\.com$/);
      expect(zone.tags).toEqual({ env: "test" });
      expect(zone.nameServers.length).toEqual(4);
      expect(zone.numberOfRecordSets).toEqual(2); // SOA + NS
      const observed = yield* getZone(rg, zone.zoneName);
      expect(observed.location).toEqual("global");
      expect(observed.properties?.zoneType).toEqual("Public");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.alchemy_id).toEqual("Zone");

      // In-place update: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.zone.zoneId).toEqual(zone.zoneId);
      expect(updated.zone.tags).toEqual({ env: "prod" });
      const retagged = yield* getZone(rg, zone.zoneName);
      expect(retagged.tags?.env).toEqual("prod");
      expect(retagged.tags?.alchemy_id).toEqual("Zone");

      // Replacement: an explicit zone name.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-dns-zone-test.com", tags: {} }),
      );
      expect(replaced.zone.zoneName).toEqual("alchemy-dns-zone-test.com");
      expect(
        (yield* getZone(rg, "alchemy-dns-zone-test.com")).tags?.alchemy_id,
      ).toEqual("Zone");
      expect(yield* untilGone(getZone(rg, zone.zoneName))).toEqual("gone");

      // Delete.
      yield* stack.deploy(groupOnly);
      expect(yield* untilGone(getZone(rg, "alchemy-dns-zone-test.com"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
