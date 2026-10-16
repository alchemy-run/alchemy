import { describe, expect, test } from "alchemy-test";
import { resolveObservedD1ReadReplication } from "@/Cloudflare/D1/Database";
import { deepEqual } from "@/Diff";

describe(
  "resolveObservedD1ReadReplication",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:d1", "local"] },
  () => {
    test("preserves omitted replication when the live mode is disabled", () => {
      const persisted = undefined;
      const observed = resolveObservedD1ReadReplication({ mode: "disabled" }, persisted);
      expect(deepEqual(observed, persisted)).toBe(true);
    });

    test("reports drift when omitted replication is enabled in the cloud", () => {
      const persisted = undefined;
      const observed = resolveObservedD1ReadReplication({ mode: "auto" }, persisted);
      expect(deepEqual(observed, persisted)).toBe(false);
      expect(observed).toEqual({ mode: "auto" });
    });

    test("preserves explicitly disabled replication when the live mode matches", () => {
      const persisted = { mode: "disabled" } as const;
      const observed = resolveObservedD1ReadReplication({ mode: "disabled" }, persisted);
      expect(deepEqual(observed, persisted)).toBe(true);
    });
  },
);
