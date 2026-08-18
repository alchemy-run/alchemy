import { describe, expect, it } from "vitest";
import { generateLambdaEntry } from "../aws.ts";
import { makeEffectDevPlugin } from "../EffectDev.ts";

describe("generateLambdaEntry effect arm (AWS)", () => {
  it("keeps the plain arm byte-compatible (kit's respond is the handler)", () => {
    const plain = generateLambdaEntry({
      serverImport: "./../output/server/index.js",
      manifestImport: "./manifest.js",
      streaming: true,
    });
    expect(plain).toContain("export const handler = toLambdaHandler(respond);");
    expect(plain).not.toContain("makeFrameworkFunctionHandler");
    expect(plain).not.toContain("alchemy/AWS");
  });

  it("effect arm is additive-only: kit's respond grafts verbatim", () => {
    const entry = generateLambdaEntry({
      serverImport: "./../output/server/index.js",
      manifestImport: "./manifest.js",
      streaming: true,
      effect: {
        main: "/abs/project/src/site.ts",
      },
    });
    expect(entry).toContain(
      `import { makeFrameworkFunctionHandler } from 'alchemy/AWS/Serve';`,
    );
    expect(entry).toContain(
      `import __alchemy_site from "/abs/project/src/site.ts";`,
    );
    expect(entry).toContain(
      "export const handler = await makeFrameworkFunctionHandler({",
    );
    expect(entry).toContain("fetch: respond,");
    // No routes gate, no match/fallthrough composition, no second wrap —
    // the wrapper owns the one streamifyResponse internally.
    expect(entry).not.toContain("routes");
    expect(entry).not.toContain("match(");
    expect(entry).not.toContain("toLambdaHandler(");
    expect(entry).not.toContain("lambdaServeBridge");
  });
});

describe("EffectDev dev plugin (config-only)", () => {
  const plugin = makeEffectDevPlugin({
    effect: { main: "/abs/project/src/site.ts" },
  });

  it("keeps alchemy external to vite's SSR transform", () => {
    const config = (plugin.config as () => any)();
    expect(config.ssr.external).toEqual(["alchemy"]);
  });

  it("mounts no middleware and serves no virtual module (the hooks mount owns dev HTTP)", () => {
    expect(plugin.configureServer).toBeUndefined();
    expect(plugin.load).toBeUndefined();
    expect(plugin.resolveId).toBeUndefined();
  });
});
