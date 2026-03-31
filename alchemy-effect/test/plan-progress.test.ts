import { describe, expect, test } from "vitest";
import {
  buildProgressRows,
  toPlanTask,
} from "../src/Cli/components/PlanProgress.tsx";
import {
  buildNamespaceTree,
  flattenTree,
} from "../src/Cli/NamespaceTree.ts";

describe("toPlanTask", () => {
  test("uses resource.Type instead of proxy fallback properties", () => {
    const resource = new Proxy(
      {
        LogicalId: "MyFunction",
        Type: "AWS.Lambda.Function",
      },
      {
        get(target, prop) {
          if (typeof prop === "symbol" || prop in target) {
            return target[prop as keyof typeof target];
          }
          return {
            kind: "PropExpr",
            identifier: String(prop),
          };
        },
      },
    );

    const task = toPlanTask("MyFunction", {
      action: "create",
      resource,
    } as any);

    expect(task.type).toBe("AWS.Lambda.Function");
    expect(task.status).toBe("pending");
  });

  test("marks noop items as success", () => {
    const task = toPlanTask("MyQueue", {
      action: "noop",
      resource: {
        LogicalId: "MyQueue",
        Type: "AWS.SQS.Queue",
      },
    } as any);

    expect(task.type).toBe("AWS.SQS.Queue");
    expect(task.status).toBe("success");
  });
});

describe("buildProgressRows", () => {
  test("retains namespace nesting for nested resources", () => {
    const rows = buildProgressRows({
      resources: {
        EventSourceMapping: {
          action: "create",
          resource: {
            LogicalId: "EventSourceMapping",
            Type: "AWS.Lambda.EventSourceMapping",
            Namespace: {
              Id: "AWS.DynamoDB.TableEventSource(JobsTable)",
              Parent: {
                Id: "JobFunction",
              },
            },
          },
          bindings: [],
          downstream: [],
          props: {},
          provider: {},
          state: undefined,
        } as any,
      },
      deletions: {},
      output: {},
    });

    expect(rows.map((row) => [row.type, row.id, row.depth])).toEqual([
      ["namespace", "JobFunction", 0],
      ["namespace", "AWS.DynamoDB.TableEventSource(JobsTable)", 1],
      ["resource", "EventSourceMapping", 2],
    ]);
  });
});

describe("flattenTree", () => {
  test("renders bindings under their owning resource", () => {
    const items = [
      {
        action: "create",
        resource: {
          LogicalId: "Sandbox",
          Type: "Cloudflare.Container",
          Namespace: undefined,
        },
        bindings: [{ sid: "Bind(DurableObject(Agents))", action: "create" }],
        downstream: [],
        props: {},
        provider: {},
        state: undefined,
      },
      {
        action: "create",
        resource: {
          LogicalId: 'DurableObject(class { ... })',
          Type: "Cloudflare.Workers.DurableObject",
          Namespace: {
            Id: "Sandbox",
          },
        },
        bindings: [],
        downstream: [],
        props: {},
        provider: {},
        state: undefined,
      },
    ] as any;

    const rows = flattenTree(buildNamespaceTree(items));

    expect(rows.map((row) => [row.type, row.id, row.depth])).toEqual([
      ["resource", "Sandbox", 0],
      ["binding", "Bind(DurableObject(Agents))", 1],
      ["resource", 'DurableObject(class { ... })', 1],
    ]);
  });
});
