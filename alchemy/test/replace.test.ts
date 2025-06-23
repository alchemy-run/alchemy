import { describe, expect } from "vitest";
import { alchemy } from "../src/alchemy.js";
import type { Context } from "../src/context.js";
import { destroy } from "../src/destroy.js";
import { Resource, ResourceID } from "../src/resource.js";
import type { Scope } from "../src/scope.js";
import "../src/test/vitest.js";
import { BRANCH_PREFIX } from "./util.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const deleted: string[] = [];
const failed = new Set();

interface Replacable extends Resource<"Replacable"> {
  name: string;
}

const Replacable = Resource(
  "Replacable",
  async function (
    this: Context<Replacable>,
    _id: string,
    props: {
      name: string;
      fail?: boolean;
      child?: boolean;
      replaceOnCreate?: boolean;
    },
  ) {
    if (props.replaceOnCreate && this.phase === "create") {
      this.replace();
    }
    if (this.phase === "delete") {
      if (props.fail) {
        if (!failed.has(props.name)) {
          failed.add(props.name);
          throw new Error(`Failed to delete ${props.name}`);
        }
      }
      deleted.push(props.name);
      return this.destroy();
    }
    if (this.phase === "update") {
      if (props.name !== this.output.name) {
        this.replace();
      }
    }
    if (props.child) {
      await Replacable("child", {
        name: "child",
      });
    }
    return this({
      name: props.name,
    });
  },
);

describe("Replace", () => {
  test("replace should flush through to downstream resources", async (scope) => {
    try {
      let resource = await Replacable("replaceable", {
        name: "foo-0",
      });
      expect(deleted).not.toContain("foo-0");
      expect(resource.name).toBe("foo-0");
      resource = await Replacable("replaceable", {
        name: "bar-0",
      });
      // the output should have changed
      expect(resource.name).toBe("bar-0");
      // but the resource should not have been deleted
      expect(deleted).not.toContain("foo-0");
      expect(deleted).not.toContain("bar-0");
      // the state should contain a record of the replaced resource
      expect(await scope.get("pendingDeletions")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resource: expect.objectContaining({
              [ResourceID]: "replaceable",
              name: "foo-0",
            }),
          }),
        ]),
      );

      await scope.finalize();

      expect(await scope.get("pendingDeletions")).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resource: expect.objectContaining({
              [ResourceID]: "replaceable",
            }),
          }),
        ]),
      );

      expect(deleted).toContain("foo-0");
      expect(deleted).not.toContain("bar-0");
    } finally {
      await destroy(scope);
      expect(deleted).toContain("bar-0");
    }
  });

  test("replace in subsequent scopes", async (scope) => {
    try {
      let resource = await alchemy.run("foo", () =>
        Replacable("replaceable", {
          name: "foo-1",
        }),
      );
      expect(deleted).not.toContain("foo-1");
      expect(resource.name).toBe("foo-1");
      let foo: Scope;
      resource = await alchemy.run("foo", (scope) => {
        foo = scope;
        return Replacable("replaceable", {
          name: "bar-1",
        });
      });
      // the output should have changed
      expect(resource.name).toBe("bar-1");
      // but the resource should not have been deleted
      expect(deleted).not.toContain("foo-1");
      expect(deleted).not.toContain("bar-1");
      // the state should contain a record of the replaced resource
      expect(await foo!.get("pendingDeletions")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resource: expect.objectContaining({
              [ResourceID]: "replaceable",
              name: "foo-1",
            }),
          }),
        ]),
      );
      // now, we finalize the scope
      await scope.finalize();
      // the state should no longer contain the replaced record
      expect(await foo!.get("pendingDeletions")).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resource: expect.objectContaining({
              [ResourceID]: "replaceable",
            }),
          }),
        ]),
      );
      // the delete of the replaced resource should have been flushed through
      expect(deleted).toContain("foo-1");
      expect(deleted).not.toContain("bar-1");
    } finally {
      await destroy(scope);
      expect(deleted).toContain("bar-1");
    }
  });

  test("replace and destroy simultaneously", async (scope) => {
    try {
      let resource = await alchemy.run("foo", () =>
        Replacable("replaceable", {
          name: "foo-2",
        }),
      );
      expect(deleted).not.toContain("foo-2");
      expect(resource.name).toBe("foo-2");
      resource = await alchemy.run("foo", () =>
        Replacable("replaceable", {
          name: "bar-2",
        }),
      );
      // the output should have changed
      expect(resource.name).toBe("bar-2");
      // but the resource should not have been deleted
      expect(deleted).not.toContain("foo-2");
      expect(deleted).not.toContain("bar-2");
      // now, we destroy the scope that contains both replaced and replacement resources
      // both must be deleted
      await destroy(scope);
      // the delete of the replaced resource should have been flushed through
      expect(deleted).toContain("foo-2");
      expect(deleted).toContain("bar-2");
      // replaced resource should be deleted first
      expect(deleted.indexOf("foo-2") < deleted.indexOf("bar-2"));
    } finally {
      await destroy(scope);
    }
  });

  test("replaced resource should be deleted on second try if it fails the first time", async (scope) => {
    try {
      let resource = await alchemy.run("foo", () =>
        Replacable("replaceable", {
          name: "foo-3",
          fail: true,
        }),
      );
      expect(deleted).not.toContain("foo-3");
      expect(resource.name).toBe("foo-3");
      resource = await alchemy.run("foo", () =>
        Replacable("replaceable", {
          name: "bar-3",
        }),
      );
      // the output should have changed
      expect(resource.name).toBe("bar-3");
      // but the resource should not have been deleted
      expect(deleted).not.toContain("foo-3");
      expect(deleted).not.toContain("bar-3");
      // first deletion of replaced resource will fail
      try {
        await scope!.finalize();
      } catch (e: any) {
        expect(e.message).toBe("Failed to delete foo-3");
      }
      // none of the resource are deleted
      expect(deleted).not.toContain("foo-3");
      expect(deleted).not.toContain("bar-3");
      // then deletion succeeds on a re-run
      await scope!.finalize();
      // foo-3 should be deleted
      expect(deleted).toContain("foo-3");
      expect(deleted).not.toContain("bar-3");

      await destroy(scope);
      // replaced resource should be deleted first
      expect(deleted.indexOf("foo-3") < deleted.indexOf("bar-3"));
    } finally {
      await destroy(scope);
    }
  });

  test("when replacing a resource multiple times, all replacements should be deleted", async (scope) => {
    try {
      let _resource = await Replacable("replaceable", {
        name: "foo-4",
      });
      _resource = await Replacable("replaceable", {
        name: "bar-4",
      });
      _resource = await Replacable("replaceable", {
        name: "baz-4",
      });
      expect(await scope.get("pendingDeletions")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resource: expect.objectContaining({
              [ResourceID]: "replaceable",
              name: "foo-4",
            }),
          }),
          expect.objectContaining({
            resource: expect.objectContaining({
              [ResourceID]: "replaceable",
              name: "bar-4",
            }),
          }),
        ]),
      );
      await scope.finalize();
      expect(deleted).toContain("foo-4");
      expect(deleted).toContain("bar-4");
    } finally {
      await destroy(scope);
    }
  });

  test("cannot replace a resource that has child resources", async (scope) => {
    try {
      await alchemy.run("foo", () =>
        Replacable("replaceable", {
          name: "foo-4",
          child: true,
        }),
      );
      await expect(
        alchemy.run("foo", () =>
          Replacable("replaceable", {
            name: "baz-4",
          }),
        ),
      ).rejects.toThrow("has children and cannot be replaced.");
    } finally {
      await destroy(scope);
    }
  });

  test("cannot replace a resource in create phase", async (scope) => {
    try {
      await expect(
        alchemy.run("test", () =>
          Replacable("replaceable", {
            name: "foo-5",
            replaceOnCreate: true,
          }),
        ),
      ).rejects.toThrow("cannot be replaced in create phase.");
    } finally {
      await destroy(scope);
    }
  });
});
