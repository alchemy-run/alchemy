import { describe, expect, it } from "vitest";
import { isDeployTarget } from "../../core/index.ts";
import { NODE_BUNDLE_CONDITIONS } from "../../core/NodeServe.ts";
import { makeAzureTarget, NITRO_PRESET } from "../azure.ts";
import type { NitroConfigSlice } from "../UserConfig.ts";

describe("Nuxt azure target", () => {
  it("builds with nitro's node preset under the azure platform", () => {
    const azure = makeAzureTarget({ nuxt: { routeRules: { "/about": { prerender: true } } } });
    expect(isDeployTarget(azure)).toBe(true);
    expect(azure.platform).toBe("azure");
    expect(azure.nitroPreset).toBe(NITRO_PRESET);
    expect(NITRO_PRESET).toBe("node");
    expect(azure.bundle?.conditions).toEqual([...NODE_BUNDLE_CONDITIONS]);
    expect(azure.config).toEqual({ nuxt: { routeRules: { "/about": { prerender: true } } } });
    // The wholesale build runs nuxt in a child process; finish writes the Fetch entry.
    expect(azure.build).toBeTypeOf("function");
    expect(azure.finish).toBeTypeOf("function");
  });

  it("turns off nitro's static file server (Blob Storage serves .output/public)", () => {
    const config: NitroConfigSlice = { serveStatic: true };
    makeAzureTarget().configureNitro?.(config, { root: "/project" });
    expect(config.serveStatic).toBe(false);
    expect(config.entry).toBeUndefined();
  });

  it("surfaces a configured main through the generic user-entry carriage", () => {
    expect(makeAzureTarget().entry).toBeUndefined();
    expect(makeAzureTarget({ main: "./server-entry.ts" }).entry).toEqual({
      main: "./server-entry.ts",
    });
  });
});
