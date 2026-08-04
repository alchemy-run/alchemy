import { describe, expect, test } from "alchemy-test";
import {
  decodeFqn,
  encodeFqn,
  encodeFqnLegacy,
  fromPath,
  FQN_SEPARATOR,
  parseFqn,
  toFqn,
  toPath,
} from "../src/FQN";
import type { NamespaceNode } from "../src/Namespace";

describe("FQN", () => {
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
      expect(toFqn(ns, "MyResource")).toBe(
        `Parent${FQN_SEPARATOR}Child${FQN_SEPARATOR}MyResource`,
      );
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

  describe("filename codec", () => {
    /** Adversarial fqns covering every escape interaction. */
    const CASES = [
      "",
      "a",
      "resource-a",
      "a/b",
      "scope/nested/resource-b",
      "a_b",
      "a__b",
      "a___b",
      "_",
      "__",
      "/",
      "//",
      "a/_/b",
      "a%b",
      "%",
      "%25",
      "%5F",
      "a%5Fb",
      "a%5F_b",
      "%%__%%",
      "a\\b",
      "\\",
      "%5C",
      "100%",
      "50%_off",
      "__stack_output__",
      "my resource (α) #1 100%",
    ];

    test("encodeFqn/decodeFqn roundtrips adversarial fqns", () => {
      for (const fqn of CASES) {
        expect(decodeFqn(encodeFqn(fqn))).toBe(fqn);
      }
    });

    test("encodeFqn is injective across all adversarial fqns", () => {
      const seen = new Map<string, string>();
      for (const fqn of CASES) {
        const encoded = encodeFqn(fqn);
        expect(seen.has(encoded) ? seen.get(encoded) : fqn).toBe(fqn);
        seen.set(encoded, fqn);
      }
    });

    test("a literal __ is distinct from an encoded separator", () => {
      expect(encodeFqn("foo__bar")).not.toBe(encodeFqn("foo/bar"));
      expect(decodeFqn(encodeFqn("foo__bar"))).toBe("foo__bar");
      expect(decodeFqn(encodeFqn("foo/bar"))).toBe("foo/bar");
    });

    test("never encodes to the stack-output bookkeeping name", () => {
      expect(encodeFqn("__stack_output__")).not.toBe("__stack_output__");
      expect(encodeFqn("/stack_output/")).not.toBe("__stack_output__");
    });

    test("encoded filenames contain no path separators", () => {
      for (const fqn of CASES) {
        const encoded = encodeFqn(fqn);
        expect(encoded).not.toContain("/");
        expect(encoded).not.toContain("\\");
      }
    });

    test("matches the legacy encoding when no character needs escaping", () => {
      // Separator-only fqns produce identical filenames under both
      // codecs, so legacy state files for namespaced resources are read
      // in place without any fallback.
      for (const fqn of ["a", "a/b", "scope/nested/resource-b", "a-b.c"]) {
        expect(encodeFqn(fqn)).toBe(encodeFqnLegacy(fqn));
      }
    });
  });
});
