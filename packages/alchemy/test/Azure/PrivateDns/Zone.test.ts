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
    const zone = yield* Azure.PrivateDns.Zone("Zone", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      tags: props.tags,
    });
    return { group, zone };
  });

// Cost: $0.50/zone-month prorated — fractions of a cent. ~1-2 minutes.
test.provider(
  "create, update tags, replace, and delete a private DNS zone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create with the generated name.
      const { group, zone } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(zone.privateZoneName).toMatch(/\.internal$/);
      expect(zone.tags).toEqual({ env: "test" });
      expect(zone.numberOfRecordSets).toEqual(1); // SOA
      const observed = yield* getZone(rg, zone.privateZoneName);
      expect(observed.location).toEqual("global");
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.alchemy_id).toEqual("Zone");

      // In-place update: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.zone.privateZoneId).toEqual(zone.privateZoneId);
      expect(updated.zone.tags).toEqual({ env: "prod" });
      const retagged = yield* getZone(rg, zone.privateZoneName);
      expect(retagged.tags?.env).toEqual("prod");
      expect(retagged.tags?.alchemy_id).toEqual("Zone");

      // Replacement: an explicit zone name.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-privatedns-zone.test", tags: {} }),
      );
      expect(replaced.zone.privateZoneName).toEqual(
        "alchemy-privatedns-zone.test",
      );
      expect(
        (yield* getZone(rg, "alchemy-privatedns-zone.test")).tags?.alchemy_id,
      ).toEqual("Zone");
      expect(yield* untilGone(getZone(rg, zone.privateZoneName))).toEqual(
        "gone",
      );

      // Delete.
      yield* stack.deploy(groupOnly);
      expect(
        yield* untilGone(getZone(rg, "alchemy-privatedns-zone.test")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
