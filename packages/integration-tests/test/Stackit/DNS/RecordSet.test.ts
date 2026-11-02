import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as dns from "@distilled.cloud/stackit/dns";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// Each case deploys its own engine-named zone (under `runs.onstackit.cloud`)
// plus record sets; DNS is billed per zone and month, so this runs ungated.
const options = { tags: stackitTags("dns", "recordset"), timeout: 300_000 } as const;

/** Out-of-band record set state: the record set, or "gone". */
const observeRecordSet = (projectId: string, zoneId: string, rrSetId: string) =>
  dns.getRecordSet({ projectId, zoneId, rrSetId }).pipe(
    Effect.map(({ rrset }) => (rrset.state === "DELETE_SUCCEEDED" ? ("gone" as const) : rrset)),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

/** Bounded wait (≤ ~90s) until the record set is gone. */
const waitUntilRecordSetGone = (projectId: string, zoneId: string, rrSetId: string) =>
  observeRecordSet(projectId, zoneId, rrSetId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (rrset) => rrset === "gone",
      times: 30,
    }),
  );

/** Bounded wait (≤ ~90s) until the zone is gone. */
const waitUntilZoneGone = (projectId: string, zoneId: string) =>
  dns.getZone({ projectId, zoneId }).pipe(
    Effect.map(({ zone }) => (zone.state === "DELETE_SUCCEEDED" ? ("gone" as const) : "found")),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (state) => state === "gone",
      times: 30,
    }),
  );

const getRecordSet = (projectId: string, zoneId: string, rrSetId: string) =>
  dns.getRecordSet({ projectId, zoneId, rrSetId }).pipe(Effect.map(({ rrset }) => rrset));

const contents = (rrset: dns.RecordSet) => rrset.records.map((record) => record.content).sort();

test.provider(
  "create, update and delete a record set",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const zone = yield* Stackit.DNS.Zone("RecordZone", {});
          const www = yield* Stackit.DNS.RecordSet("Www", {
            zoneId: zone.zoneId,
            name: "www",
            type: "A",
            records: ["192.0.2.1"],
            ttl: 300,
            comment: "first",
          });
          return { zone, www };
        }),
      );

      const { zone, www } = created;
      expect(www.rrSetId).toEqual(expect.any(String));
      expect(www.zoneId).toEqual(zone.zoneId);
      expect(www.zoneDnsName).toEqual(zone.dnsName);
      expect(www.fqdn).toEqual(`www.${zone.dnsName}`);
      expect(www.type).toEqual("A");
      expect(www.records).toEqual(["192.0.2.1"]);
      expect(www.ttl).toEqual(300);
      expect(www.comment).toEqual("first");

      const fetched = yield* getRecordSet(projectId, zone.zoneId, www.rrSetId);
      expect(fetched.name.replace(/\.$/, "")).toEqual(`www.${zone.dnsName}`);
      expect(fetched.type).toEqual("A");
      expect(contents(fetched)).toEqual(["192.0.2.1"]);
      expect(fetched.ttl).toEqual(300);
      expect(fetched.comment).toEqual("first");

      // Update records, TTL and comment in place.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const zone = yield* Stackit.DNS.Zone("RecordZone", {});
          const www = yield* Stackit.DNS.RecordSet("Www", {
            zoneId: zone.zoneId,
            name: "www",
            type: "A",
            records: ["192.0.2.1", "192.0.2.2"],
            ttl: 600,
            comment: "second",
          });
          return { zone, www };
        }),
      );

      expect(updated.www.rrSetId).toEqual(www.rrSetId);
      expect(updated.www.records).toEqual(["192.0.2.1", "192.0.2.2"]);
      expect(updated.www.ttl).toEqual(600);

      const refetched = yield* getRecordSet(projectId, zone.zoneId, www.rrSetId);
      expect(contents(refetched)).toEqual(["192.0.2.1", "192.0.2.2"]);
      expect(refetched.ttl).toEqual(600);
      expect(refetched.comment).toEqual("second");

      // Shrinking the record list removes the dropped record.
      yield* stack.deploy(
        Effect.gen(function* () {
          const zone = yield* Stackit.DNS.Zone("RecordZone", {});
          return yield* Stackit.DNS.RecordSet("Www", {
            zoneId: zone.zoneId,
            name: "www",
            type: "A",
            records: ["192.0.2.2"],
            ttl: 600,
            comment: "second",
          });
        }),
      );
      const shrunk = yield* getRecordSet(projectId, zone.zoneId, www.rrSetId);
      expect(contents(shrunk)).toEqual(["192.0.2.2"]);
      expect(shrunk.ttl).toEqual(600);

      yield* stack.destroy();

      expect(yield* waitUntilRecordSetGone(projectId, zone.zoneId, www.rrSetId)).toEqual("gone");
      expect(yield* waitUntilZoneGone(projectId, zone.zoneId)).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider(
  "changing the name or type replaces the record set",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          const zone = yield* Stackit.DNS.Zone("ReplaceRecordZone", {});
          const record = yield* Stackit.DNS.RecordSet("Record", {
            zoneId: zone.zoneId,
            name: "api",
            type: "A",
            records: ["192.0.2.10"],
          });
          return { zone, record };
        }),
      );
      const zoneId = first.zone.zoneId;

      // Type change, same name: replaced (delete first).
      const retyped = yield* stack.deploy(
        Effect.gen(function* () {
          const zone = yield* Stackit.DNS.Zone("ReplaceRecordZone", {});
          return yield* Stackit.DNS.RecordSet("Record", {
            zoneId: zone.zoneId,
            name: "api",
            type: "TXT",
            records: ['"alchemy-replaced"'],
          });
        }),
      );
      expect(retyped.rrSetId).not.toEqual(first.record.rrSetId);
      expect(retyped.type).toEqual("TXT");
      expect(yield* waitUntilRecordSetGone(projectId, zoneId, first.record.rrSetId)).toEqual(
        "gone",
      );
      const txt = yield* getRecordSet(projectId, zoneId, retyped.rrSetId);
      expect(txt.type).toEqual("TXT");
      expect(txt.name.replace(/\.$/, "")).toEqual(`api.${first.zone.dnsName}`);

      // Name change: replaced (create first).
      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          const zone = yield* Stackit.DNS.Zone("ReplaceRecordZone", {});
          return yield* Stackit.DNS.RecordSet("Record", {
            zoneId: zone.zoneId,
            name: "api2",
            type: "TXT",
            records: ['"alchemy-replaced"'],
          });
        }),
      );
      expect(renamed.rrSetId).not.toEqual(retyped.rrSetId);
      expect(renamed.fqdn).toEqual(`api2.${first.zone.dnsName}`);
      expect(yield* waitUntilRecordSetGone(projectId, zoneId, retyped.rrSetId)).toEqual("gone");

      yield* stack.destroy();

      expect(yield* waitUntilRecordSetGone(projectId, zoneId, renamed.rrSetId)).toEqual("gone");
      expect(yield* waitUntilZoneGone(projectId, zoneId)).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider(
  "list enumerates record sets of owned zones, without SOA and apex NS",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const zone = yield* Stackit.DNS.Zone("ListRecordZone", {});
          const record = yield* Stackit.DNS.RecordSet("Listed", {
            zoneId: zone.zoneId,
            type: "TXT",
            records: ['"listed"'],
          });
          return { zone, record };
        }),
      );

      // Engine-generated record name.
      expect(deployed.record.name).toEqual(expect.any(String));
      expect(deployed.record.fqdn).toEqual(`${deployed.record.name}.${deployed.zone.dnsName}`);

      const provider = yield* Provider.findProvider(Stackit.DNS.RecordSet);
      const all = yield* provider.list();
      const inZone = all.filter((row) => row.zoneId === deployed.zone.zoneId);
      expect(inZone.map((row) => row.rrSetId)).toContain(deployed.record.rrSetId);
      expect(inZone.some((row) => row.type === "SOA")).toEqual(false);
      expect(inZone.some((row) => row.type === "NS" && row.fqdn === deployed.zone.dnsName)).toEqual(
        false,
      );

      yield* stack.destroy();

      expect(
        yield* waitUntilRecordSetGone(projectId, deployed.zone.zoneId, deployed.record.rrSetId),
      ).toEqual("gone");
      expect(yield* waitUntilZoneGone(projectId, deployed.zone.zoneId)).toEqual("gone");
    }).pipe(logLevel),
  options,
);
