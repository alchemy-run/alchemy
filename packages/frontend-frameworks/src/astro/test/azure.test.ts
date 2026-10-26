import { describe, expect, it } from "vitest";
import { makeAzureTarget, target } from "../azure.ts";
import { makeNodeTarget } from "../node.ts";

describe("makeAzureTarget", () => {
  it("keeps the Node adapter and bundle conditions on the azure platform", () => {
    const azure = makeAzureTarget();
    const node = makeNodeTarget();
    expect(azure.platform).toBe("azure");
    expect(azure.bundle?.conditions).toEqual(node.bundle?.conditions);
    expect(azure.integration().name).toBe(node.integration().name);
    expect(azure.build).toBeTypeOf("function");
  });

  it("exposes the named `target` module export as the factory", () => {
    expect(target).toBe(makeAzureTarget);
  });
});
