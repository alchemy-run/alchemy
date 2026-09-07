import { describe, expect, it } from "vitest";
import { NODE_BUNDLE_CONDITIONS } from "../../core/NodeServe.ts";
import {
  SERVER_ENTRY_NAME,
  VINEXT_NODE_INSTALL,
  makeNodeTarget,
  makeVinextServeEntrySource,
  target,
} from "../node.ts";

describe("makeNodeTarget", () => {
  it("declares the node platform and a wholesale vinext build (not Cloudflare)", () => {
    const node = makeNodeTarget();
    expect(node.platform).toBe("node");
    expect(node.build).toBeTypeOf("function");
    expect(node.bundle?.conditions).toEqual([...NODE_BUNDLE_CONDITIONS]);
    expect(node.bundle?.external ?? []).not.toContain("cloudflare:");
    expect(node.bundle?.external ?? []).not.toContain("@aws-sdk/");
  });

  it("writes a startProdServer serve entry with /health, not a Worker fetch handler", () => {
    const source = makeVinextServeEntrySource();
    expect(SERVER_ENTRY_NAME).toBe("server/serve-node.mjs");
    expect(source).toContain('from "vinext/server/prod-server"');
    expect(source).toContain("startProdServer");
    expect(source).toContain("/health");
    expect(source).toContain("process.env.PORT");
    expect(source).not.toContain("vinext/server/fetch-handler");
    expect(source).not.toContain("aws-lambda");
    expect(source).not.toContain("cloudflare");
    expect(source).not.toContain("worker/index.ts");
  });

  it("installs vinext and React at runtime instead of bundling them", () => {
    expect(VINEXT_NODE_INSTALL).toContain("vinext");
    expect(VINEXT_NODE_INSTALL).toContain("react");
    expect(VINEXT_NODE_INSTALL).toContain("react-dom");
    expect(VINEXT_NODE_INSTALL).toContain("react-server-dom-webpack");
  });

  it("exposes the named `target` module export as the factory", () => {
    expect(target).toBe(makeNodeTarget);
  });
});
