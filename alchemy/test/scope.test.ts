import { describe, expect } from "bun:test";
import fs from "node:fs/promises";
import { alchemy } from "../src/alchemy.js";
import { destroy } from "../src/destroy.js";
import { FileSystemStateStore } from "../src/fs/file-system-state-store.js";
import { File } from "../src/fs/file.js";
import { Scope } from "../src/scope.js";
import { BRANCH_PREFIX } from "./util.js";

import { Resource } from "../src/resource.js";
import { serializeScope } from "../src/serde.js";
import "../src/test/bun.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Scope", () => {
  test("should maintain scope context and track resources", async (scope) => {
    try {
      await File("file", {
        path: "test.txt",
        content: "Hello World",
      });

      const content = await fs.readFile("test.txt", "utf-8");
      expect(content).toBe("Hello World");

      expect(Scope.current).toEqual(scope);
      expect(scope.resources.size).toBe(1);
      expect(scope).toBe(scope);
    } finally {
      await destroy(scope);
    }
  });

  test("should have phase available in stateStore callback", async () => {
    let observedPhase: string | undefined;
    new Scope({
      scopeName: "phase-test",
      phase: "read",
      stateStore: (scope) => {
        observedPhase = scope.phase;
        return new FileSystemStateStore(scope);
      },
    });
    expect(observedPhase).toBe("read");
  });

  test("serialized scope should be equal to the original scope", async (scope) => {
    try {
      await File("foo", {
        path: "test2.txt",
        content: "Hello World",
      });
      await alchemy.run("bar", async () => {
        await File("baz", {
          path: "test3.txt",
          content: "Hello World",
        });
        await Nested("gaz");
      });

      const serialized: any = await serializeScope(scope.root);
      expect(serialized).toEqual({
        "samgoodwin/samgoodwin-scope.test.ts/serialized scope should be equal to the original scope/foo":
          {
            "Symbol(alchemy::ResourceKind)": "fs::File",
            "Symbol(alchemy::ResourceID)": "foo",
            "Symbol(alchemy::ResourceFQN)":
              "samgoodwin/samgoodwin-scope.test.ts/serialized scope should be equal to the original scope/foo",
            "Symbol(alchemy::ResourceScope)": {
              "@scope": null,
            },
            "Symbol(alchemy::ResourceSeq)": 0,
            path: "test2.txt",
            content: "Hello World",
          },
        "samgoodwin/samgoodwin-scope.test.ts/serialized scope should be equal to the original scope/bar/baz":
          {
            "Symbol(alchemy::ResourceKind)": "fs::File",
            "Symbol(alchemy::ResourceID)": "baz",
            "Symbol(alchemy::ResourceFQN)":
              "samgoodwin/samgoodwin-scope.test.ts/serialized scope should be equal to the original scope/bar/baz",
            "Symbol(alchemy::ResourceScope)": {
              "@scope": null,
            },
            "Symbol(alchemy::ResourceSeq)": 0,
            path: "test3.txt",
            content: "Hello World",
          },
        "samgoodwin/samgoodwin-scope.test.ts/serialized scope should be equal to the original scope/bar/gaz":
          {
            "Symbol(alchemy::ResourceKind)": "Nested",
            "Symbol(alchemy::ResourceID)": "gaz",
            "Symbol(alchemy::ResourceFQN)":
              "samgoodwin/samgoodwin-scope.test.ts/serialized scope should be equal to the original scope/bar/gaz",
            "Symbol(alchemy::ResourceScope)": {
              "@scope": null,
            },
            "Symbol(alchemy::ResourceSeq)": 1,
          },
        "samgoodwin/samgoodwin-scope.test.ts/serialized scope should be equal to the original scope/bar/gaz/file":
          {
            "Symbol(alchemy::ResourceKind)": "fs::File",
            "Symbol(alchemy::ResourceID)": "file",
            "Symbol(alchemy::ResourceFQN)":
              "samgoodwin/samgoodwin-scope.test.ts/serialized scope should be equal to the original scope/bar/gaz/file",
            "Symbol(alchemy::ResourceScope)": {
              "@scope": null,
            },
            "Symbol(alchemy::ResourceSeq)": 0,
            path: "test4.txt",
            content: "Hello World",
          },
      });
    } finally {
      await destroy(scope);
    }
  });
});

const Nested = Resource("Nested", async function (this, _id: string) {
  await File("file", {
    path: "test4.txt",
    content: "Hello World",
  });
  return this({});
});
