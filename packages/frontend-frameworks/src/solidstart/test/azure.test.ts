import { describe, expect, it } from "vitest";
import { isDeployTarget } from "../../core/index.ts";
import { target } from "../azure.ts";
import { NITRO_PRESET } from "../node.ts";

describe("SolidStart azure target", () => {
  it("reuses the Node build (nitro node-listener) under the azure platform", () => {
    const azure = target({ nitro: { prerender: { routes: ["/about"] } } });
    expect(isDeployTarget(azure)).toBe(true);
    expect(azure.platform).toBe("azure");
    expect(azure.nitroPreset).toBe(NITRO_PRESET);
    expect(azure.config).toEqual({ nitro: { prerender: { routes: ["/about"] } } });
    expect(azure.build).toBeTypeOf("function");
    expect(azure.finish).toBeTypeOf("function");
  });
});
