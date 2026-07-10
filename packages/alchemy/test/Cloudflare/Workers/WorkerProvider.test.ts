import {
  DurableObjectClassMoved,
  getConflictingCrossScriptDoBindings,
  normalizeStateDomains,
} from "@/Cloudflare/Workers/WorkerProvider";
import { describe, expect, test } from "@effect/vitest";

describe("WorkerProvider", () => {
  describe("DurableObjectClassMoved", () => {
    // The default (non-opt-in) path fails loudly before any upload with an
    // actionable message: (a) the class moved cross-script, (b) DO data does
    // not transfer and the delete is irreversible, (c) how to proceed (#799).
    const err = new DurableObjectClassMoved({
      scriptName: "worker-b",
      classNames: ["MyDOClass"],
    });

    test("names the moved class and the former host", () => {
      expect(err.message).toContain("'MyDOClass'");
      expect(err.message).toContain("worker-b");
    });

    test("warns that data does not transfer and the delete is irreversible", () => {
      expect(err.message).toMatch(/does NOT transfer/i);
      expect(err.message).toMatch(/cannot be undone/i);
    });

    test("points at the explicit opt-in to proceed", () => {
      expect(err.message).toContain("deleteMovedDurableObjectClasses: true");
    });

    test("is a tagged error", () => {
      expect(err._tag).toBe("DurableObjectClassMoved");
    });
  });

  describe("getConflictingCrossScriptDoBindings", () => {
    // A Durable Object class that moves from this worker to another script
    // becomes a cross-script binding (`scriptName` set to the new host) while
    // the class simultaneously lands in `deletedClasses` for this worker. That
    // combination is exactly what Cloudflare rejects in a single upload, so it
    // must trigger the two-phase upload path (#799).
    const worker = "worker-b";
    const foreign = "worker-a";

    test("flags a cross-script binding whose class is being deleted", () => {
      const bindings = [
        {
          type: "durable_object_namespace",
          name: "EDITOR_DO",
          className: "MyDOClass",
          scriptName: foreign,
        },
      ];
      expect(
        getConflictingCrossScriptDoBindings(bindings, ["MyDOClass"], worker),
      ).toEqual(bindings);
    });

    test("ignores a locally-owned DO binding (no scriptName)", () => {
      const bindings = [
        {
          type: "durable_object_namespace",
          name: "DO",
          className: "MyDOClass",
        },
      ];
      expect(
        getConflictingCrossScriptDoBindings(bindings, ["MyDOClass"], worker),
      ).toEqual([]);
    });

    test("ignores a self-referencing binding (scriptName === worker)", () => {
      const bindings = [
        {
          type: "durable_object_namespace",
          name: "DO",
          className: "MyDOClass",
          scriptName: worker,
        },
      ];
      expect(
        getConflictingCrossScriptDoBindings(bindings, ["MyDOClass"], worker),
      ).toEqual([]);
    });

    test("ignores a cross-script binding whose class is NOT being deleted", () => {
      const bindings = [
        {
          type: "durable_object_namespace",
          name: "DO",
          className: "OtherClass",
          scriptName: foreign,
        },
      ];
      expect(
        getConflictingCrossScriptDoBindings(bindings, ["MyDOClass"], worker),
      ).toEqual([]);
    });

    test("ignores non-DO bindings and returns only conflicting entries", () => {
      const conflicting = {
        type: "durable_object_namespace",
        name: "EDITOR_DO",
        className: "MyDOClass",
        scriptName: foreign,
      };
      const bindings = [
        { type: "plain_text", name: "VAR", className: "MyDOClass" },
        {
          type: "durable_object_namespace",
          name: "LOCAL_DO",
          className: "LocalClass",
        },
        conflicting,
      ];
      expect(
        getConflictingCrossScriptDoBindings(bindings, ["MyDOClass"], worker),
      ).toEqual([conflicting]);
    });

    test("returns empty when nothing is being deleted", () => {
      const bindings = [
        {
          type: "durable_object_namespace",
          name: "EDITOR_DO",
          className: "MyDOClass",
          scriptName: foreign,
        },
      ];
      expect(getConflictingCrossScriptDoBindings(bindings, [], worker)).toEqual(
        [],
      );
    });
  });

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
