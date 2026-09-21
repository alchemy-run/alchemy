import * as AWS from "@/AWS";
import { Dns } from "@/Dns.ts";
import * as Test from "@/Test/Alchemy";
import * as route53 from "@distilled.cloud/aws/route-53";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

/**
 * The testing account hosts no Route 53 zone, so the live seam roundtrip is
 * gated on `AWS_TEST_ROUTE53_ZONE` — the apex name of a PUBLIC hosted zone
 * the credentials can write to (e.g. `example.com`). Without it the test is
 * a clean skip; the body still type-checks the layer and the seam.
 */
const ZONE_NAME = process.env.AWS_TEST_ROUTE53_ZONE;
const RECORD_NAME = `alchemy-route53dns-seam.${ZONE_NAME ?? "example.com"}`;
const RECORD_VALUE = '"alchemy route53 dns seam"';

const normalizeName = (name: string) => name.replace(/\.$/, "").toLowerCase();

/** Resolve the hosted zone id for the configured apex name. */
const findZoneId = (zoneName: string) =>
  route53
    .listHostedZonesByName({ DNSName: zoneName, MaxItems: 1 })
    .pipe(
      Effect.map((response) =>
        response.HostedZones?.find(
          (zone) => normalizeName(zone.Name) === normalizeName(zoneName),
        )?.Id.replace(/^\/hostedzone\//, ""),
      ),
    );

/** The TXT values Route 53 serves for the seam record, if it exists. */
const readRecord = (hostedZoneId: string) =>
  route53
    .listResourceRecordSets({
      HostedZoneId: hostedZoneId,
      StartRecordName: RECORD_NAME,
      StartRecordType: "TXT",
      MaxItems: 1,
    })
    .pipe(
      Effect.map((response) =>
        response.ResourceRecordSets?.find(
          (set) =>
            normalizeName(set.Name) === normalizeName(RECORD_NAME) &&
            set.Type === "TXT",
        )?.ResourceRecords?.map((record) => record.Value),
      ),
    );

// The Route 53 implementation of the `Alchemy.Dns` seam: a record declared
// through `dns.record(...)` with NO hosted zone becomes an
// `AWS.Route53.Record` whose reconcile infers the governing zone from the
// name; destroy removes it. Verified out of band through Route 53.
test.provider.skipIf(!ZONE_NAME)(
  "declares and removes a record through the Route 53 Dns seam",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const declared = yield* stack.deploy(
        Effect.gen(function* () {
          const dns = yield* Dns;
          const record = yield* dns.record("SeamRecord", {
            name: RECORD_NAME,
            type: "TXT",
            values: [RECORD_VALUE],
          });
          return { name: record.name, type: record.type };
        }).pipe(Effect.provide(AWS.Route53Dns())),
      );
      expect(declared).toEqual({ name: RECORD_NAME, type: "TXT" });

      const hostedZoneId = yield* findZoneId(ZONE_NAME!);
      expect(hostedZoneId).toBeDefined();
      expect(yield* readRecord(hostedZoneId!)).toEqual([RECORD_VALUE]);

      yield* stack.destroy();

      expect(yield* readRecord(hostedZoneId!)).toBeUndefined();
    }),
  { timeout: 180_000 },
);
