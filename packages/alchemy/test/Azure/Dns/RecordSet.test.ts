import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { withPublicIps } from "../gates.ts";
import { getRecord, logLevel, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const zoneOnly = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const zone = yield* Azure.Dns.Zone("Zone", {
    resourceGroup: group.resourceGroupName,
  });
  return { group, zone };
});

const program = (
  props: Omit<Azure.Dns.RecordSetProps, "resourceGroup" | "zoneName">,
) =>
  Effect.gen(function* () {
    const { group, zone } = yield* zoneOnly;
    const where = {
      resourceGroup: group.resourceGroupName,
      zoneName: zone.zoneName,
    };
    const record = yield* Azure.Dns.RecordSet("Www", { ...where, ...props });
    const txt = yield* Azure.Dns.RecordSet("Txt", {
      ...where,
      recordType: "TXT",
      txtRecords: ["hello", "x".repeat(300)],
    });
    const mx = yield* Azure.Dns.RecordSet("Mx", {
      ...where,
      recordType: "MX",
      name: "@",
      mxRecords: [
        { preference: 10, exchange: "mail1.example.org" },
        { preference: 20, exchange: "mail2.example.org" },
      ],
    });
    const caa = yield* Azure.Dns.RecordSet("Caa", {
      ...where,
      recordType: "CAA",
      name: "@",
      caaRecords: [{ flags: 0, tag: "issue", value: "letsencrypt.org" }],
    });
    const srv = yield* Azure.Dns.RecordSet("Srv", {
      ...where,
      recordType: "SRV",
      name: "_sip._tcp",
      srvRecords: [
        { priority: 10, weight: 5, port: 5060, target: "sip.example.org" },
      ],
    });
    const ns = yield* Azure.Dns.RecordSet("Ns", {
      ...where,
      recordType: "NS",
      name: "dev",
      nsRecords: ["ns1.example.org", "ns2.example.org"],
    });
    return { group, zone, record, txt, mx, caa, srv, ns };
  });

// Cost: record sets are free; one zone at $0.50/month prorated — fractions
// of a cent. ~2-3 minutes.
test.provider(
  "create, update, replace, and delete DNS record sets",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const created = yield* stack.deploy(
        program({
          recordType: "A",
          name: "www",
          ttl: 300,
          aRecords: ["203.0.113.10", "203.0.113.11"],
          metadata: { owner: "test" },
        }),
      );
      const { group, zone, record, txt, mx, caa, srv, ns } = created;
      const rg = group.resourceGroupName;
      const zoneName = zone.zoneName;
      expect(record.fqdn).toEqual(`www.${zoneName}.`);
      expect(record.aRecords).toEqual(["203.0.113.10", "203.0.113.11"]);
      expect(record.metadata).toEqual({ owner: "test" });
      const observed = yield* getRecord(rg, zoneName, "A", "www");
      expect(observed.properties?.TTL).toEqual(300);
      expect(observed.properties?.metadata?.owner).toEqual("test");
      expect(observed.properties?.metadata?.alchemy_id).toEqual("Www");
      expect(
        (observed.properties?.ARecords ?? []).map((r) => r.ipv4Address).sort(),
      ).toEqual(["203.0.113.10", "203.0.113.11"]);

      expect(txt.txtRecords.sort()).toEqual(["hello", "x".repeat(300)]);
      const observedTxt = yield* getRecord(
        rg,
        zoneName,
        "TXT",
        txt.recordSetName,
      );
      expect(
        observedTxt.properties?.TXTRecords?.find((r) => r.value?.length === 2)
          ?.value?.[0]?.length,
      ).toEqual(255);
      expect(mx.mxRecords.map((r) => r.preference).sort()).toEqual([10, 20]);
      expect(
        (yield* getRecord(rg, zoneName, "MX", "@")).properties?.MXRecords
          ?.length,
      ).toEqual(2);
      expect(caa.caaRecords).toEqual([
        { flags: 0, tag: "issue", value: "letsencrypt.org" },
      ]);
      expect(
        (yield* getRecord(rg, zoneName, "CAA", "@")).properties?.caaRecords?.[0]
          ?.value,
      ).toEqual("letsencrypt.org");
      expect(srv.srvRecords[0]?.port).toEqual(5060);
      expect(ns.nsRecords.sort()).toEqual([
        "ns1.example.org",
        "ns2.example.org",
      ]);
      expect(
        (yield* getRecord(rg, zoneName, "NS", "dev")).properties?.NSRecords
          ?.length,
      ).toEqual(2);

      // In-place update: ttl, records, metadata.
      const updated = yield* stack.deploy(
        program({
          recordType: "A",
          name: "www",
          ttl: 60,
          aRecords: ["203.0.113.12"],
          metadata: { owner: "ops" },
        }),
      );
      expect(updated.record.recordSetId).toEqual(record.recordSetId);
      expect(updated.record.ttl).toEqual(60);
      expect(updated.record.aRecords).toEqual(["203.0.113.12"]);
      const reobserved = yield* getRecord(rg, zoneName, "A", "www");
      expect(reobserved.properties?.TTL).toEqual(60);
      expect(reobserved.properties?.metadata?.owner).toEqual("ops");
      expect(
        (reobserved.properties?.ARecords ?? []).map((r) => r.ipv4Address),
      ).toEqual(["203.0.113.12"]);

      // Replacement: a new name.
      const renamed = yield* stack.deploy(
        program({
          recordType: "A",
          name: "www2",
          ttl: 60,
          aRecords: ["203.0.113.12"],
        }),
      );
      expect(renamed.record.fqdn).toEqual(`www2.${zoneName}.`);
      expect(
        (yield* getRecord(rg, zoneName, "A", "www2")).properties?.metadata
          ?.alchemy_id,
      ).toEqual("Www");
      expect(yield* untilGone(getRecord(rg, zoneName, "A", "www"))).toEqual(
        "gone",
      );

      // Replacement: a new record type under the same name (delete first,
      // since a CNAME cannot coexist with other records).
      const cname = yield* stack.deploy(
        program({
          recordType: "CNAME",
          name: "www2",
          cname: "target.example.org",
        }),
      );
      expect(cname.record.cname).toEqual("target.example.org");
      expect(
        (yield* getRecord(rg, zoneName, "CNAME", "www2")).properties
          ?.CNAMERecord?.cname,
      ).toEqual("target.example.org");
      expect(yield* untilGone(getRecord(rg, zoneName, "A", "www2"))).toEqual(
        "gone",
      );

      // Delete.
      yield* stack.deploy(zoneOnly);
      expect(
        yield* untilGone(getRecord(rg, zoneName, "CNAME", "www2")),
      ).toEqual("gone");
      expect(
        yield* untilGone(getRecord(rg, zoneName, "TXT", txt.recordSetName)),
      ).toEqual("gone");
      expect(yield* untilGone(getRecord(rg, zoneName, "MX", "@"))).toEqual(
        "gone",
      );
      expect(yield* untilGone(getRecord(rg, zoneName, "NS", "dev"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Cost: one Standard static public IP (~$0.005/hour) plus a zone for a few
// minutes — fractions of a cent. ~2 minutes.
test.provider(
  "alias A record set targeting a public IP address",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, zone, ip, alias } = yield* stack.deploy(
        Effect.gen(function* () {
          const { group, zone } = yield* zoneOnly;
          const ip = yield* Azure.Network.PublicIpAddress("Ip", {
            resourceGroup: group.resourceGroupName,
          });
          const alias = yield* Azure.Dns.RecordSet("Alias", {
            resourceGroup: group.resourceGroupName,
            zoneName: zone.zoneName,
            recordType: "A",
            name: "@",
            ttl: 300,
            targetResourceId: ip.publicIpAddressId,
          });
          return { group, zone, ip, alias };
        }),
      );
      expect(alias.targetResourceId?.toLowerCase()).toEqual(
        ip.publicIpAddressId.toLowerCase(),
      );
      const observed = yield* getRecord(
        group.resourceGroupName,
        zone.zoneName,
        "A",
        "@",
      );
      expect(observed.properties?.targetResource?.id?.toLowerCase()).toEqual(
        ip.publicIpAddressId.toLowerCase(),
      );

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getRecord(group.resourceGroupName, zone.zoneName, "A", "@"),
        ),
      ).toEqual("gone");
    }).pipe(withPublicIps(1), logLevel),
  { tags, timeout: 600_000 },
);
