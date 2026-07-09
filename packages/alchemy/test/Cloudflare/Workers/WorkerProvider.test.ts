import {
  normalizeStateDomains,
  resolveWorkersDev,
  stateCustomDomains,
} from "@/Cloudflare/Workers/WorkerProvider";
import { describe, expect, test } from "@effect/vitest";

describe("WorkerProvider", () => {
  describe("normalizeStateDomains", () => {
    // Worker state has gone through three generations: <= beta.44 stored each
    // custom domain as a `{ id, hostname, zoneId }` object; beta.45 – beta.57
    // stored `https://<hostname>` URL strings (with the workers.dev URL mixed
    // in); the current format stores bare hostnames aligned with `allUrls`.
    // The diff path reads all three without throwing (#546).
    test("coerces legacy domain objects to hostnames", () => {
      expect(
        normalizeStateDomains([
          { id: "abc", hostname: "metrics.example.com", zoneId: "z1" },
        ]),
      ).toEqual(["metrics.example.com"]);
    });

    test("coerces legacy https:// URL strings to hostnames", () => {
      expect(
        normalizeStateDomains([
          "https://app.example.com",
          "https://my-worker.acct.workers.dev",
        ]),
      ).toEqual(["app.example.com", "my-worker.acct.workers.dev"]);
    });

    test("leaves current-format hostnames untouched", () => {
      expect(normalizeStateDomains(["app.example.com", "localhost"])).toEqual([
        "app.example.com",
        "localhost",
      ]);
    });

    test("drops entries that fit no state generation", () => {
      expect(
        normalizeStateDomains([
          "https://keep.example.com",
          { id: "no-hostname" },
          { hostname: 123 },
          null,
          42,
          "",
        ]),
      ).toEqual(["keep.example.com"]);
    });

    test("returns an empty array for undefined state", () => {
      expect(normalizeStateDomains(undefined)).toEqual([]);
    });
  });

  describe("stateCustomDomains", () => {
    test("excludes workers.dev, preview, and local-dev entries", () => {
      expect(
        stateCustomDomains([
          "my-worker.acct.workers.dev",
          "0a1b2c3d-my-worker.acct.workers.dev",
          "localhost",
          "192.168.0.12",
          "app.example.com",
        ]),
      ).toEqual(["app.example.com"]);
    });

    test("reads legacy URL-string state", () => {
      expect(
        stateCustomDomains([
          "https://app.example.com",
          "https://my-worker.acct.workers.dev",
        ]),
      ).toEqual(["app.example.com"]);
    });
  });

  describe("resolveWorkersDev", () => {
    test("defaults to the full workers.dev behavior", () => {
      expect(resolveWorkersDev(undefined)).toEqual({
        url: true,
        previews: true,
      });
      expect(resolveWorkersDev(true)).toEqual({ url: true, previews: true });
    });

    test("false disables both toggles", () => {
      expect(resolveWorkersDev(false)).toEqual({ url: false, previews: false });
    });

    test("object form fills unset toggles with true", () => {
      expect(resolveWorkersDev({})).toEqual({ url: true, previews: true });
      expect(resolveWorkersDev({ url: false })).toEqual({
        url: false,
        previews: true,
      });
      expect(resolveWorkersDev({ previews: false })).toEqual({
        url: true,
        previews: false,
      });
      expect(resolveWorkersDev({ url: false, previews: true })).toEqual({
        url: false,
        previews: true,
      });
    });
  });
});
