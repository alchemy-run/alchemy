import { describe, expect, test } from "@effect/vitest";
import {
  buildNamespaceTree,
  deriveNamespaceAction,
  flattenTree,
} from "../../src/Cli/NamespaceTree";
import type { CRUD } from "../../src/Plan";

const makeMockCRUD = (
  logicalId: string,
  namespace: { Id: string; Parent?: { Id: string } } | undefined,
  action: CRUD["action"],
): CRUD =>
  ({
    action,
    resource: {
      LogicalId: logicalId,
      Namespace: namespace,
      Type: "Test.Resource",
    },
    bindings: [],
    downstream: [],
  }) as unknown as CRUD;

const ns = (...ids: string[]) =>
  ids.reduce<{ Id: string; Parent?: { Id: string } } | undefined>(
    (parent, Id) => ({ Id, Parent: parent }),
    undefined,
  );

describe("NamespaceTree", () => {
  describe("buildNamespaceTree", () => {
    test("creates flat structure for resources without namespace", () => {
      const items: CRUD[] = [
        makeMockCRUD("ResourceA", undefined, "create"),
        makeMockCRUD("ResourceB", undefined, "update"),
      ];
      const tree = buildNamespaceTree(items);
      expect(tree.resources.length).toBe(2);
      expect(tree.children.size).toBe(0);
    });

    test("creates nested structure for namespaced resources", () => {
      const items: CRUD[] = [
        makeMockCRUD("ResourceA", { Id: "Parent" }, "create"),
        makeMockCRUD("ResourceB", { Id: "Child", Parent: { Id: "Parent" } }, "update"),
      ];
      const tree = buildNamespaceTree(items);
      expect(tree.resources.length).toBe(0);
      expect(tree.children.size).toBe(1);
      expect(tree.children.has("Parent")).toBe(true);
      const parent = tree.children.get("Parent")!;
      expect(parent.resources.length).toBe(1);
      expect(parent.children.has("Child")).toBe(true);
    });
  });

  describe("deriveNamespaceAction", () => {
    test("returns noop for empty tree", () => {
      const tree = buildNamespaceTree([]);
      expect(deriveNamespaceAction(tree)).toBe("noop");
    });

    test("returns single action when all children have same action", () => {
      const items: CRUD[] = [
        makeMockCRUD("ResourceA", undefined, "create"),
        makeMockCRUD("ResourceB", undefined, "create"),
      ];
      const tree = buildNamespaceTree(items);
      expect(deriveNamespaceAction(tree)).toBe("create");
    });

    test("returns mixed when children have different actions", () => {
      const items: CRUD[] = [
        makeMockCRUD("ResourceA", undefined, "create"),
        makeMockCRUD("ResourceB", undefined, "delete"),
      ];
      const tree = buildNamespaceTree(items);
      expect(deriveNamespaceAction(tree)).toBe("mixed");
    });
  });

  describe("flattenTree", () => {
    test("flattens tree with correct depth", () => {
      const items: CRUD[] = [
        makeMockCRUD("Root", undefined, "create"),
        makeMockCRUD("Nested", { Id: "Parent" }, "update"),
      ];
      const tree = buildNamespaceTree(items);
      const flat = flattenTree(tree);

      // Should have: Parent namespace, Nested resource, Root resource
      expect(flat.length).toBe(3);
      expect(flat[0].type).toBe("namespace");
      expect(flat[0].id).toBe("Parent");
      expect(flat[0].depth).toBe(0);
      expect(flat[1].type).toBe("resource");
      expect(flat[1].id).toBe("Nested");
      expect(flat[1].depth).toBe(1);
      expect(flat[2].type).toBe("resource");
      expect(flat[2].id).toBe("Root");
      expect(flat[2].depth).toBe(0);
    });

    test("re-homes host-rooted bindings and resources under the host resource", () => {
      const host = makeMockCRUD("JobFunction", undefined, "create");
      host.bindings = [
        {
          sid: "Allow(JobFunction, AWS.S3.GetObject(JobsBucket))",
          action: "create",
          namespace: ns("JobFunction", "AWS.S3.GetObject(JobsBucket)"),
        },
      ];

      const bucket = makeMockCRUD("JobsBucket", undefined, "create");
      bucket.bindings = [
        {
          sid: "AWS.S3.Notifications(JobsBucket)",
          action: "create",
          namespace: ns("JobFunction", "AWS.S3.BucketEventSource(JobsBucket)"),
        },
      ];

      const permission = makeMockCRUD(
        "AWS.Lambda.InvokeFunction(JobsBucket)",
        ns("JobFunction", "AWS.S3.BucketEventSource(JobsBucket)"),
        "create",
      );
      permission.resource.Type = "AWS.Lambda.Permission";

      const flat = flattenTree(buildNamespaceTree([host, bucket, permission]));
      const rendered = flat.map((item) => `${item.depth}:${item.type}:${item.id}`);

      expect(rendered).toContain("0:resource:JobFunction");
      expect(rendered).toContain("1:namespace:AWS.S3.BucketEventSource(JobsBucket)");
      expect(rendered).toContain(
        "2:resource:AWS.Lambda.InvokeFunction(JobsBucket)",
      );
      expect(rendered).toContain("2:binding:AWS.S3.Notifications(JobsBucket)");
      expect(rendered).not.toContain("0:resource:AWS.Lambda.InvokeFunction(JobsBucket)");
      expect(rendered).not.toContain("1:namespace:JobFunction");
    });
  });
});
