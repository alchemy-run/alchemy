import { describe, expect, test } from "@alchemy.run/test";
import {
  decodeFqn,
  encodedFqnReason,
  encodeFqn,
  fromPath,
  FQN_SEPARATOR,
  parseFqn,
  toFqn,
  toPath,
} from "../src/FQN";
import type { NamespaceNode } from "../src/Namespace";

describe("FQN", { tags: ["unit", "local"] }, () => {
  describe("encodedFqnReason", () => {
    test("accepts ids whose file name reads back as the same id", () => {
      for (const fqn of [
        "Bucket",
        "My/Resource",
        "snake_case/id_1",
        "a/b/c",
        "x-y.z",
        "_leading",
        "trailing_",
        "a/_b",
      ]) {
        expect(encodedFqnReason(fqn)).toBeUndefined();
      }
    });

    test("refuses ids whose file name reads back as another id", () => {
      // `My__Resource` is stored as `My__Resource`, which lists as `My/Resource`.
      expect(encodeFqn("My/Resource")).toEqual(encodeFqn("My__Resource"));
      // `a_/b` and `a/_b` are both stored as `a___b`, which lists as `a/_b`.
      expect(encodeFqn("a/_b")).toEqual(encodeFqn("a_/b"));
      for (const fqn of [
        "My__Resource",
        "a_/b",
        "a___b",
        // a store's own bookkeeping file
        "__stack_output__",
      ]) {
        expect(encodedFqnReason(fqn)).toBeDefined();
      }
    });

    test("no two accepted ids share a file name", () => {
      const ids = [""];
      for (let length = 0; length < 7; length++) {
        for (const id of ids.filter((id) => id.length === length)) {
          for (const char of ["a", "_", "/"]) ids.push(id + char);
        }
      }
      const owners = new Map<string, string>();
      for (const fqn of ids.filter((id) => encodedFqnReason(id) === undefined)) {
        const name = encodeFqn(fqn);
        expect(owners.get(name) ?? fqn).toEqual(fqn);
        owners.set(name, fqn);
        expect(decodeFqn(name)).toEqual(fqn);
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
