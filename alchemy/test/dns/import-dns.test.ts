import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy";
import { destroy } from "../../src/destroy";
import { ImportDnsRecords } from "../../src/dns/import-dns";
import { BRANCH_PREFIX } from "../util";
// must import this or else alchemy.test won't exist
import "../../src/test/bun";

const test = alchemy.test(import.meta);

describe("ImportDnsRecords Resource", () => {
  const testDomain = "example.com";

  test("import all DNS records", async (scope) => {
    try {
      // Import all DNS records
      const records = await ImportDnsRecords(`${BRANCH_PREFIX}-${testDomain}`, {
        domain: testDomain,
      });

      // Verify the resource structure
      expect(records.domain).toBe(testDomain);
      expect(records.importedAt).toBeTruthy();
      expect(records.records).toBeTruthy();

      // Verify we got some records back
      expect(Object.keys(records.records).length).toBeGreaterThan(0);

      // Verify record structure for each type
      for (const [type, typeRecords] of Object.entries(records.records)) {
        expect(Array.isArray(typeRecords)).toBe(true);
        if (typeRecords.length > 0) {
          const record = typeRecords[0];
          expect(record.name).toBeTruthy();
          expect(record.type).toBeTruthy();
          expect(record.TTL).toBeTruthy();
          expect(record.data).toBeTruthy();
        }
      }
    } finally {
      await destroy(scope);
    }
  });

  test("import specific DNS record types", async (scope) => {
    try {
      // Import only A and MX records
      const records = await ImportDnsRecords(
        `${BRANCH_PREFIX}-${testDomain}-specific`,
        {
          domain: testDomain,
          recordTypes: ["A", "MX"],
        },
      );

      // Verify we only got the requested record types
      expect(Object.keys(records.records)).toEqual(["A", "MX"]);

      // Verify record structure
      for (const typeRecords of Object.values(records.records)) {
        if (typeRecords.length > 0) {
          const record = typeRecords[0];
          expect(record.name).toBeTruthy();
          expect(record.type).toBeTruthy();
          expect(record.TTL).toBeTruthy();
          expect(record.data).toBeTruthy();
        }
      }
    } finally {
      await destroy(scope);
    }
  });

  test("handle non-existent domain", async (scope) => {
    try {
      const records = await ImportDnsRecords(`${BRANCH_PREFIX}-non-existent`, {
        domain: "this-domain-definitely-does-not-exist-12345.com",
      });

      // Verify we get an empty result set
      expect(records.domain).toBe(
        "this-domain-definitely-does-not-exist-12345.com",
      );
      expect(records.importedAt).toBeTruthy();
      expect(records.records).toBeTruthy();

      // All record types should be empty arrays
      for (const typeRecords of Object.values(records.records)) {
        expect(Array.isArray(typeRecords)).toBe(true);
        expect(typeRecords.length).toBe(0);
      }
    } finally {
      await destroy(scope);
    }
  });
});
