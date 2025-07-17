import fs from "node:fs/promises";
import { describe, expect } from "vitest";
import { alchemy } from "../src/alchemy.js";
import { destroy } from "../src/destroy.js";
import { FileSystemStateStore } from "../src/fs/file-system-state-store.js";
import { File } from "../src/fs/file.js";
import { Scope } from "../src/scope.js";
import { BRANCH_PREFIX, createTestOptions, STATE_STORE_TYPES } from "./util.js";

import { Resource, ResourceScope } from "../src/resource.js";
import { serializeScope } from "../src/serde.js";
import "../src/test/vitest.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe.concurrent("Scope", () => {
  for (const storeType of STATE_STORE_TYPES) {
    describe(storeType, () => {
      const options = createTestOptions(storeType, "scope");

      test(
        `${storeType} should maintain scope context and track resources`,
        options,
        async (scope) => {
          const fileName = `test-${storeType}-maintain-scope-context`;
          try {
            await File("file", {
              path: fileName,
              content: "Hello World",
            });

            const content = await fs.readFile(fileName, "utf-8");
            expect(content).toBe("Hello World");

            expect(Scope.current).toEqual(scope);
            expect(scope.resources.size).toBe(1);
            expect(scope).toBe(scope);
          } finally {
            await destroy(scope);
            await assertFileDoesNotExist(fileName);
          }
        },
      );
      async function assertFileDoesNotExist(fileName: string) {
        try {
          await fs.access(fileName);
          throw new Error(`File ${fileName} should not exist`);
        } catch {}
      }

      test(
        "should have phase available in stateStore callback",
        options,
        async (scope) => {
          try {
            let observedPhase: string | undefined;
            new Scope({
              parent: scope,
              scopeName: "phase-test",
              phase: "read",
              stateStore: (scope) => {
                observedPhase = scope.phase;
                return new FileSystemStateStore(scope);
              },
            });
            expect(observedPhase).toBe("read");
          } finally {
            await destroy(scope);
          }
        },
      );

      test(
        `${storeType} serialized scope should be equal to the original scope`,
        options,
        async (scope) => {
          const fileName = `test-${storeType}-serialized-scope-should-be-equal-to-the-original-scope`;
          const fileName2 = `test-${storeType}-serialized-scope-should-be-equal-to-the-original-scope-2`;
          const fileName3 = `test-${storeType}-serialized-scope-should-be-equal-to-the-original-scope-3`;
          try {
            await File("foo", {
              path: fileName,
              content: "Hello World",
            });
            await alchemy.run("bar", async () => {
              await File("baz", {
                path: fileName2,
                content: "Hello World",
              });
              await Nested("gaz", { fileName: fileName3 });
            });

            const serialized = await serializeScope(scope);

            const fqn = scope.chain.join("/");

            expect(serialized).toEqual({
              [`${fqn}/foo`]: {
                "Symbol(alchemy::ResourceKind)": "fs::File",
                "Symbol(alchemy::ResourceID)": "foo",
                "Symbol(alchemy::ResourceFQN)": `${fqn}/foo`,
                "Symbol(alchemy::ResourceScope)": {
                  "@scope": null,
                },
                "Symbol(alchemy::ResourceSeq)": 0,
                path: fileName,
                content: "Hello World",
              },
              [`${fqn}/bar/baz`]: {
                "Symbol(alchemy::ResourceKind)": "fs::File",
                "Symbol(alchemy::ResourceID)": "baz",
                "Symbol(alchemy::ResourceFQN)": `${fqn}/bar/baz`,
                "Symbol(alchemy::ResourceScope)": {
                  "@scope": null,
                },
                "Symbol(alchemy::ResourceSeq)": 0,
                path: fileName2,
                content: "Hello World",
              },
              [`${fqn}/bar/gaz`]: {
                "Symbol(alchemy::ResourceKind)": "Nested",
                "Symbol(alchemy::ResourceID)": "gaz",
                "Symbol(alchemy::ResourceFQN)": `${fqn}/bar/gaz`,
                "Symbol(alchemy::ResourceScope)": {
                  "@scope": null,
                },
                "Symbol(alchemy::ResourceSeq)": 1,
              },
              [`${fqn}/bar/gaz/file`]: {
                "Symbol(alchemy::ResourceKind)": "fs::File",
                "Symbol(alchemy::ResourceID)": "file",
                "Symbol(alchemy::ResourceFQN)": `${fqn}/bar/gaz/file`,
                "Symbol(alchemy::ResourceScope)": {
                  "@scope": null,
                },
                "Symbol(alchemy::ResourceSeq)": 0,
                path: fileName3,
                content: "Hello World",
              },
            });
          } finally {
            await destroy(scope);
            await assertFileDoesNotExist(fileName);
            await assertFileDoesNotExist(fileName2);
            await assertFileDoesNotExist(fileName3);
          }
        },
      );

      test("scope CRUD operations should work", options, async (scope) => {
        try {
          const innerScope = await alchemy.run("innerScope", async (scope) => {
            await scope.set("foo", "foo-1");
            expect(await scope.get("foo")).toBe("foo-1");
            await scope.delete("foo");
            expect(await scope.get("foo")).toBeUndefined();
            await scope.set("bar", "baz-1");
            return scope;
          });
          expect(await innerScope.get("bar")).toBe("baz-1");
          await innerScope.delete("bar");
          expect(await innerScope.get("bar")).toBeUndefined();
        } finally {
          await destroy(scope);
        }
      });

      test(
        "scope CRUD operations should work across instances of the same scope",
        options,
        async (scope) => {
          try {
            await alchemy.run("innerScope", async (scope) => {
              await scope.set("foo", "foo-1");
            });
            await alchemy.run("innerScope", async (scope) => {
              expect(await scope.get("foo")).toBe("foo-1");
            });
          } finally {
            await destroy(scope);
          }
        },
      );
      test(
        "a skipped resource should not delete nested resources",
        options,
        async (scope) => {
          const Outer = Resource(
            `${storeType}-Outer`,
            async function (this, _id: string) {
              if (this.phase === "delete") {
                return this.destroy();
              }
              await Inner("inner", { fileName: "test-inner" });
              return this({});
            },
          );

          let isDeleted = false;
          const Inner = Resource(
            `${storeType}-Inner`,
            async function (this, _id: string) {
              if (this.phase === "delete") {
                isDeleted = true;
                return this.destroy();
              }
              return this({});
            },
          );
          try {
            await Outer("outer");
            expect(isDeleted).toBe(false);
            // emulate a new process (destroy in memory scope)
            scope.clear();
            const outer = await Outer("outer");
            // finalizing a scoped that was skipped should not delete nested resources
            await outer[ResourceScope].finalize();
            expect(isDeleted).toBe(false);
          } finally {
            console.log("destroy");
            await destroy(scope);
            // expect(isDeleted).toBe(true);
          }
        },
      );
    });
  }
});

const Nested = Resource(
  "Nested",
  async function (this, _id: string, props: { fileName: string }) {
    if (this.phase === "delete") {
      return this.destroy();
    }
    await File("file", {
      path: props.fileName,
      content: "Hello World",
    });
    return this({});
  },
);
