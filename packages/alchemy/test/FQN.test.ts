import { describe, expect, test } from "@alchemy.run/test";
import {
  encodeFqn,
  fromPath,
  FQN_SEPARATOR,
  invalidFqnReason,
  parseFqn,
  toFqn,
  toPath,
} from "../src/FQN";
import type { NamespaceNode } from "../src/Namespace";

describe("FQN", { tags: ["unit", "local"] }, () => {
  describe("invalidFqnReason", () => {
    test("accepts ids whose encoding no other id can produce", () => {
      for (const fqn of ["Bucket", "My/Resource", "snake_case/id_1", "a/b/c", "x-y.z"]) {
        expect(invalidFqnReason(fqn)).toBeUndefined();
      }
    });

    test("refuses ids that could encode to another id's file name", () => {
      // Colliding pairs: `My/Resource` stays valid, `My__Resource` is refused;
      // `a/_b` and `a_/b` both encode to `a___b`, so both are refused.
      expect(encodeFqn("My/Resource")).toEqual(encodeFqn("My__Resource"));
      expect(invalidFqnReason("My/Resource")).toBeUndefined();
      expect(encodeFqn("a/_b")).toEqual(encodeFqn("a_/b"));
      for (const fqn of [
        "My__Resource",
        "a/_b",
        "a_/b",
        "_leading",
        "trailing_",
        // a store's own bookkeeping file
        "__stack_output__",
      ]) {
        expect(invalidFqnReason(fqn)).toBeDefined();
      }
    });
  });

  describe("toPath", () => {
    test("returns empty array for undefined namespace", () => {
      expect(toPath(undefined)).toEqual([]);
    });

    test("returns single element for root namespace", () => {
      const ns: NamespaceNode = { Id: "Root" };
      expect(toPath(ns)).toEqual(["Root"]);
    });

    test("returns path from root to leaf", () => {
      const ns: NamespaceNode = {
        Id: "Child",
        Parent: {
          Id: "Parent",
          Parent: { Id: "Root" },
        },
      };
      expect(toPath(ns)).toEqual(["Root", "Parent", "Child"]);
    });
  });

  describe("toFqn", () => {
    test("returns logicalId for undefined namespace", () => {
      expect(toFqn(undefined, "MyResource")).toBe("MyResource");
    });

    test("returns namespace-qualified name", () => {
      const ns: NamespaceNode = { Id: "Parent" };
      expect(toFqn(ns, "MyResource")).toBe(`Parent${FQN_SEPARATOR}MyResource`);
    });

    test("handles deep namespace", () => {
      const ns: NamespaceNode = {
        Id: "Child",
        Parent: { Id: "Parent" },
      };
      expect(toFqn(ns, "MyResource")).toBe(`Parent${FQN_SEPARATOR}Child${FQN_SEPARATOR}MyResource`);
    });
  });

  describe("parseFqn", () => {
    test("parses simple logicalId", () => {
      expect(parseFqn("MyResource")).toEqual({
        path: [],
        logicalId: "MyResource",
      });
    });

    test("parses namespaced FQN", () => {
      expect(parseFqn("Parent/Child/MyResource")).toEqual({
        path: ["Parent", "Child"],
        logicalId: "MyResource",
      });
    });

    test("parses single namespace FQN", () => {
      expect(parseFqn("Parent/MyResource")).toEqual({
        path: ["Parent"],
        logicalId: "MyResource",
      });
    });
  });

  describe("fromPath", () => {
    test("returns undefined for empty path", () => {
      expect(fromPath([])).toBeUndefined();
    });

    test("returns single node for single element", () => {
      const result = fromPath(["Root"]);
      expect(result).toEqual({ Id: "Root", Parent: undefined });
    });

    test("returns nested nodes", () => {
      const result = fromPath(["Root", "Parent", "Child"]);
      expect(result).toEqual({
        Id: "Child",
        Parent: {
          Id: "Parent",
          Parent: { Id: "Root", Parent: undefined },
        },
      });
    });
  });

  describe("roundtrip", () => {
    test("toFqn -> parseFqn -> fromPath -> toFqn", () => {
      const ns: NamespaceNode = {
        Id: "Child",
        Parent: { Id: "Parent" },
      };
      const logicalId = "MyResource";
      const fqn = toFqn(ns, logicalId);
      const parsed = parseFqn(fqn);
      const reconstructedNs = fromPath(parsed.path);
      const roundtripFqn = toFqn(reconstructedNs, parsed.logicalId);
      expect(roundtripFqn).toBe(fqn);
    });
  });
});
