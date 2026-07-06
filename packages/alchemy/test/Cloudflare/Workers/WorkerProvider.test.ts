import type { WorkerProps } from "@/Cloudflare/Workers/Worker";
import {
  normalizeStateDomains,
  resolveMetadataHashValue,
  resolveWorkerMetadataHash,
} from "@/Cloudflare/Workers/WorkerProvider";
import { describe, expect, test } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

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

  // #745: metadata-only edits (compatibility, observability, env literals, …)
  // don't touch the bundle/vite/asset-content hashes, so the update decision
  // used to plan them as a noop and never deploy them. The metadata hash is
  // what makes them visible to the diff.
  describe("resolveWorkerMetadataHash", () => {
    const stack = { name: "test-stack", stage: "test" };
    const hashFor = (props: WorkerProps) =>
      Effect.runPromise(
        resolveWorkerMetadataHash({
          props,
          bindings: [],
          accountId: "acct-1",
          stack,
        }),
      );

    test("a changed compatibility flag changes the hash", async () => {
      const before = await hashFor({
        compatibility: { flags: ["nodejs_als"] },
      });
      const after = await hashFor({
        compatibility: { flags: ["nodejs_als", "no_nodejs_compat"] },
      });
      expect(after).not.toBe(before);
    });

    test("a changed observability config changes the hash", async () => {
      const before = await hashFor({ observability: { enabled: true } });
      const after = await hashFor({ observability: { enabled: false } });
      expect(after).not.toBe(before);
    });

    test("identical props produce an identical hash", async () => {
      const props: WorkerProps = {
        compatibility: { flags: ["nodejs_als"] },
        observability: { enabled: true },
        tags: ["a", "b"],
      };
      expect(await hashFor(props)).toBe(await hashFor({ ...props }));
    });

    test("redacted env values affect the hash by value, not reference", async () => {
      const withSecret = await hashFor({
        env: { API_KEY: Redacted.make("s3cret") },
      });
      // A second, independently-constructed Redacted with the same contents
      // must hash identically — the hash reads through to the value.
      const sameSecret = await hashFor({
        env: { API_KEY: Redacted.make("s3cret") },
      });
      const otherSecret = await hashFor({
        env: { API_KEY: Redacted.make("different") },
      });
      expect(sameSecret).toBe(withSecret);
      expect(otherSecret).not.toBe(withSecret);
    });

    test("materialization drops functions and undefined-valued fields", async () => {
      const materialized = await Effect.runPromise(
        resolveMetadataHashValue({
          keep: "x",
          n: 1,
          fn: () => "ignored",
          missing: undefined,
        }),
      );
      expect(materialized).toEqual({ keep: "x", n: 1 });
    });
  });
});
