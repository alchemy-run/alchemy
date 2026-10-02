import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as privatedns from "@distilled.cloud/azure/privatedns";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const zoneOnly = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const zone = yield* Azure.PrivateDns.Zone("Zone", {
    resourceGroup: group.resourceGroupName,
  });
  return { group, zone };
});

const program = (
  props: Omit<
    Azure.PrivateDns.RecordSetProps,
    "resourceGroup" | "privateZoneName"
  >,
) =>
  Effect.gen(function* () {
    const { group, zone } = yield* zoneOnly;
    const record = yield* Azure.PrivateDns.RecordSet("Www", {
      resourceGroup: group.resourceGroupName,
      privateZoneName: zone.privateZoneName,
      ...props,
    });
    const txt = yield* Azure.PrivateDns.RecordSet("Txt", {
      resourceGroup: group.resourceGroupName,
      privateZoneName: zone.privateZoneName,
      recordType: "TXT",
      txtRecords: ["hello", "x".repeat(300)],
    });
    return { group, zone, record, txt };
  });

const getRecord = (
  resourceGroupName: string,
  privateZoneName: string,
  recordType: string,
  relativeRecordSetName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    privatedns.GetRecordSet({
      subscriptionId,
      resourceGroupName,
      privateZoneName,
      recordType,
      relativeRecordSetName,
    }),
  );

// Cost: record sets are free; one zone at $0.50/month prorated — fractions
// of a cent. ~2-3 minutes.
test.provider(
  "create, update, replace, and delete a private DNS record set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const created = yield* stack.deploy(
        program({
          recordType: "A",
          name: "www",
          ttl: 300,
          aRecords: ["10.0.0.4", "10.0.0.5"],
          metadata: { owner: "test" },
        }),
      );
      const { group, zone, record, txt } = created;
      const rg = group.resourceGroupName;
      const zoneName = zone.privateZoneName;
      expect(record.fqdn).toEqual(`www.${zoneName}.`);
      expect(record.aRecords).toEqual(["10.0.0.4", "10.0.0.5"]);
      expect(record.metadata).toEqual({ owner: "test" });
      const observed = yield* getRecord(rg, zoneName, "A", "www");
      expect(observed.properties?.ttl).toEqual(300);
      expect(observed.properties?.metadata?.alchemy_id).toEqual("Www");
      expect(
        observed.properties?.aRecords?.map((r) => r.ipv4Address).sort(),
      ).toEqual(["10.0.0.4", "10.0.0.5"]);
      expect(txt.txtRecords.sort()).toEqual(["hello", "x".repeat(300)].sort());
      const observedTxt = yield* getRecord(
        rg,
        zoneName,
        "TXT",
        txt.recordSetName,
      );
      expect(
        observedTxt.properties?.txtRecords?.map((r) => r.value?.length).sort(),
      ).toEqual([1, 2]);

      // In-place update: ttl, addresses, metadata.
      const updated = yield* stack.deploy(
        program({
          recordType: "A",
          name: "www",
          ttl: 60,
          aRecords: ["10.0.0.6"],
          metadata: { owner: "prod" },
        }),
      );
      expect(updated.record.recordSetId).toEqual(record.recordSetId);
      const reobserved = yield* getRecord(rg, zoneName, "A", "www");
      expect(reobserved.properties?.ttl).toEqual(60);
      expect(reobserved.properties?.aRecords).toEqual([
        { ipv4Address: "10.0.0.6" },
      ]);
      expect(reobserved.properties?.metadata?.owner).toEqual("prod");

      // Replacement: same name, different record type (delete first).
      const replaced = yield* stack.deploy(
        program({
          recordType: "CNAME",
          name: "www",
          ttl: 60,
          cname: "target.example.com",
        }),
      );
      expect(replaced.record.recordType).toEqual("CNAME");
      expect(replaced.record.cname).toEqual("target.example.com");
      const cname = yield* getRecord(rg, zoneName, "CNAME", "www");
      expect(cname.properties?.cnameRecord?.cname).toEqual(
        "target.example.com",
      );
      expect(yield* untilGone(getRecord(rg, zoneName, "A", "www"))).toEqual(
        "gone",
      );

      // Delete.
      yield* stack.deploy(zoneOnly);
      expect(yield* untilGone(getRecord(rg, zoneName, "CNAME", "www"))).toEqual(
        "gone",
      );
      expect(
        yield* untilGone(getRecord(rg, zoneName, "TXT", txt.recordSetName)),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
