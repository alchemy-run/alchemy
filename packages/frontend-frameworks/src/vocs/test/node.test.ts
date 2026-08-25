import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { NODE_BUNDLE_CONDITIONS } from "../../core/NodeServe.ts";
import type { BuildOutput } from "../../core/index.ts";
import { makeNodeTarget, target } from "../node.ts";

const emptyBuild: BuildOutput = {
  clientDirectory: "/project/dist/public",
  serverModules: [{ name: "server/index.js", content: "x", hash: "h" }],
  externalWorkspaces: new Set(),
};

describe("makeNodeTarget", () => {
  it("is an assets-only node target with a wholesale child build", () => {
    const node = makeNodeTarget();
    expect(node.platform).toBe("node");
    expect(node.build).toBeTypeOf("function");
    expect(node.finish).toBeTypeOf("function");
    expect(node.bundle?.conditions).toEqual([...NODE_BUNDLE_CONDITIONS]);
    expect(typeof node.adapter).toBe("function");
    expect(typeof node.vitePlugins).toBe("function");
  });

  it("drops serverModules in the finishing pass", async () => {
    const node = makeNodeTarget();
    const output = await Effect.runPromise(
      node.finish!(emptyBuild, { root: "/project" }),
    );
    expect(output.serverModules).toBeUndefined();
    expect(output.clientDirectory).toBe(emptyBuild.clientDirectory);
  });

  it("exposes the named `target` module export as the factory", () => {
    expect(target).toBe(makeNodeTarget);
  });
});
