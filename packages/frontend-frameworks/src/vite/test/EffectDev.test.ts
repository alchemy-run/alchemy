import { describe, expect, it } from "vitest";
import { makeEffectDevPlugin } from "../effect.ts";

describe("EffectDev plugin (config-only)", () => {
  const plugin = makeEffectDevPlugin({
    effect: { main: "/abs/project/src/site.ts" },
  });

  it("is dev-only and forces one alchemy instance (ssr.external)", () => {
    expect(plugin.apply).toBe("serve");
    expect(plugin.enforce).toBe("pre");
    const config = (plugin.config as () => { ssr: { external: string[] } })();
    expect(config.ssr.external).toEqual(["alchemy"]);
  });

  it("mounts no middleware and serves no virtual module (the mount owns dev HTTP)", () => {
    expect(plugin.configureServer).toBeUndefined();
    expect(plugin.load).toBeUndefined();
    expect(plugin.resolveId).toBeUndefined();
  });
});
