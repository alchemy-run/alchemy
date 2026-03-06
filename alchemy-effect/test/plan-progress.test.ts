import { describe, expect, test } from "vitest";
import { toPlanTask } from "../src/Cli/components/PlanProgress.tsx";

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
