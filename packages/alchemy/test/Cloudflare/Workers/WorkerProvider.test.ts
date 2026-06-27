import { normalizeStateDomains } from "@/Cloudflare/Workers/WorkerProvider";
import { describe, expect, test } from "@effect/vitest";

describe("WorkerProvider", () => {
  describe("normalizeStateDomains", () => {
    // Worker state written by Alchemy <= beta.44 stored each custom domain as a
    // `{ id, hostname, zoneId }` object; beta.45+ stores `https://<hostname>`
    // strings. The diff path then called `.endsWith` directly on each entry and
    // threw `u.endsWith is not a function` when reading the older object state
    // (#546).
    test("coerces legacy domain objects to https:// strings", () => {
      expect(
        normalizeStateDomains([
          { id: "abc", hostname: "metrics.example.com", zoneId: "z1" },
        ]),
      ).toEqual(["https://metrics.example.com"]);
    });

    test("leaves modern string entries untouched", () => {
      expect(
        normalizeStateDomains([
          "https://app.example.com",
          "https://my-worker.acct.workers.dev",
        ]),
      ).toEqual([
        "https://app.example.com",
        "https://my-worker.acct.workers.dev",
      ]);
    });

    test("keeps the diff filter and workers.dev lookup working after normalization", () => {
      const normalized = normalizeStateDomains([
        { id: "abc", hostname: "app.example.com", zoneId: "z1" },
        "https://my-worker.acct.workers.dev",
      ]);
      // custom domains used by the domainsChanged diff (workers.dev excluded)
      expect(normalized.filter((u) => !u.endsWith(".workers.dev"))).toEqual([
        "https://app.example.com",
      ]);
      // the workers.dev url stays findable for the `newUrl` computation
      expect(normalized.find((u) => u.endsWith(".workers.dev"))).toBe(
        "https://my-worker.acct.workers.dev",
      );
    });

    test("drops entries that are neither strings nor objects with a string hostname", () => {
      expect(
        normalizeStateDomains([
          "https://keep.example.com",
          { id: "no-hostname" },
          { hostname: 123 },
          null,
          42,
        ]),
      ).toEqual(["https://keep.example.com"]);
    });

    test("returns an empty array for undefined state", () => {
      expect(normalizeStateDomains(undefined)).toEqual([]);
    });
  });
});
