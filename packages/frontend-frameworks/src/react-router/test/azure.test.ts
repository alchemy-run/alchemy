import { describe, expect, it } from "vitest";
import { isDeployTarget } from "../../core/index.ts";
import { target } from "../azure.ts";

describe("React Router azure target", () => {
  it("reuses the Node build under the azure platform", () => {
    const azure = target({ buildDirectory: "out" });
    expect(isDeployTarget(azure)).toBe(true);
    expect(azure.platform).toBe("azure");
    expect(azure.config).toEqual({ buildDirectory: "out" });
    expect(azure.build).toBeTypeOf("function");
    expect(azure.finish).toBeTypeOf("function");
  });
});
