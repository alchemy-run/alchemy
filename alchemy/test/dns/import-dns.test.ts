import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy.js";
import { destroy } from "../../src/destroy.js";
import { ImportDnsRecords } from "../../src/dns/import-dns.js";
import { BRANCH_PREFIX } from "../util.js";

import "../../src/test/bun.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("ImportDnsRecords Resource", () => {
  const testDomain = "google.com";

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
      expect(Array.isArray(records.records)).toBe(true);

      // Verify we got some records back
      expect(records.records.length).toBeGreaterThan(0);

      // Verify record structure
      if (records.records.length > 0) {
        const record = records.records[0];
        expect(record.name).toBeTruthy();
        expect(record.type).toBeTruthy();
        expect(record.TTL).toBeTruthy();
        expect(record.data).toBeTruthy();
        expect(record.content).toBeTruthy(); // Compatibility field
        expect(record.ttl).toBeTruthy(); // Lowercase ttl field

        // For regular records (not MX), content should match data
        if (record.type !== "MX") {
          expect(record.content).toEqual(record.data);
        } else {
          // For MX records, validate the special format
          expect(record.priority).toBeDefined();
          expect(typeof record.priority).toBe("number");
          expect(record.data).toMatch(/^\d+\s+.+/); // data should have priority prefix
          expect(record.content).not.toMatch(/^\d+\s+/); // content should just be hostname
        }

        expect(record.ttl).toEqual(record.TTL); // lowercase ttl should match uppercase TTL
      }

      // Verify we have different record types
      const types = new Set(records.records.map((r) => r.type));
      expect(types.size).toBeGreaterThan(0);
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

      // Verify array structure
      expect(Array.isArray(records.records)).toBe(true);

      // Verify we only got the requested record types
      const recordTypes = new Set(records.records.map((r) => r.type));
      expect(recordTypes.size).toBeLessThanOrEqual(2);
      for (const type of recordTypes) {
        expect(["A", "MX"]).toContain(type);
      }

      // Verify record structure
      if (records.records.length > 0) {
        const record = records.records[0];
        expect(record.name).toBeTruthy();
        expect(record.type).toBeTruthy();
        expect(record.TTL).toBeTruthy();
        expect(record.data).toBeTruthy();
        expect(record.content).toBeTruthy(); // Compatibility field
        expect(record.ttl).toBeTruthy(); // Lowercase ttl field
      }
    } finally {
      await destroy(scope);
    }
  });

  test("properly format MX records", async (scope) => {
    try {
      // Import only MX records
      const records = await ImportDnsRecords(
        `${BRANCH_PREFIX}-${testDomain}-mx`,
        {
          domain: testDomain,
          recordTypes: ["MX"],
        },
      );

      // Verify we got some records back
      expect(records.records.length).toBeGreaterThan(0);

      // Check MX records format
      const mxRecords = records.records.filter((r) => r.type === "MX");

      // Skip test if no MX records found
      if (mxRecords.length > 0) {
        for (const record of mxRecords) {
          // Verify basic structure
          expect(record.type).toBe("MX");
          expect(record.data).toBeTruthy();
          expect(record.content).toBeTruthy();

          // Verify priority extraction
          expect(record.priority).toBeDefined();
          expect(typeof record.priority).toBe("number");

          // Verify data contains priority but content doesn't
          expect(record.data).toMatch(/^\d+\s+.+/); // Data should start with a number
          expect(record.content).not.toMatch(/^\d+\s+/); // Content should not start with a number

          // Check that priority + " " + content = data (approximately)
          // We need to handle trailing dots that might be normalized
          const reconstructedData = `${record.priority} ${record.content}`;
          const normalizedData = record.data.replace(/\.$/, "");
          const normalizedReconstructed = reconstructedData.replace(/\.$/, "");

          // They should match when normalized
          expect(normalizedReconstructed).toBe(normalizedData);
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

      // Records should be an empty array
      expect(Array.isArray(records.records)).toBe(true);
      expect(records.records.length).toBe(0);
    } finally {
      await destroy(scope);
    }
  });
});
