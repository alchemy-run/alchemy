import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanForExplicitServeMount } from "../Adapter.ts";
import { matchServerRoutes } from "../EffectDev.ts";
import { generateWorkerShim } from "../WorkerShim.ts";

describe("generateWorkerShim effect arm", () => {
  const effect = generateWorkerShim({
    serverImport: "./../output/server/index.js",
    manifestImport: "./../cloudflare-tmp/manifest.js",
    assetsBinding: "ASSETS",
    effect: {
      main: "/abs/project/src/site.ts",
      routes: ["/api/*"],
      durableObjects: ["Counter"],
      workflows: ["Flow"],
      stack: { name: "my-stack", stage: "dev" },
    },
  });

  it("keeps the plain arm byte-compatible (kit handler is the default export)", () => {
    const plain = generateWorkerShim({
      serverImport: "./server/index.js",
      manifestImport: "./manifest.js",
      assetsBinding: "ASSETS",
    });
    expect(plain).toContain("export default kit_handler;");
    expect(plain).not.toContain("makeWebsiteExports");
    expect(plain).not.toContain("alchemy/Serve");
  });

  it("wraps kit in makeWebsiteExports with the site module and routes", () => {
    expect(effect).toContain(
      `import { makeWebsiteExports, DurableObjectBridge } from "alchemy/Serve/Worker";`,
    );
    expect(effect).toContain(
      `import __alchemy_site from "/abs/project/src/site.ts";`,
    );
    expect(effect).toContain(
      "export default makeWebsiteExports(WorkerEntrypoint, {",
    );
    expect(effect).toContain(`routes: ["/api/*"],`);
    // kit stays reachable as the fallback — never a second listener.
    expect(effect).toContain(
      "framework: () => Promise.resolve({ default: kit_handler }),",
    );
    expect(effect).not.toContain("export default kit_handler;");
  });

  it("re-exports Durable Object bridge classes", () => {
    expect(effect).toContain(
      "const __alchemyDurableObjectBridge = DurableObjectBridge(DurableObject, { site: __alchemy_site });",
    );
    expect(effect).toContain(
      'export class Counter extends __alchemyDurableObjectBridge("Counter") {}',
    );
  });

  it("re-exports Workflow bridge classes with the baked stack identity", () => {
    expect(effect).toContain(
      `import { makeWorkflowBridge } from "alchemy/Cloudflare";`,
    );
    expect(effect).toContain(
      'export class Flow extends __alchemyWorkflowBridge("Flow") {}',
    );
    expect(effect).toContain('stack: { name: "my-stack", stage: "dev" }');
  });

  it("omits DO/Workflow scaffolding when the site exports none", () => {
    const fetchOnly = generateWorkerShim({
      serverImport: "./server/index.js",
      manifestImport: "./manifest.js",
      assetsBinding: "ASSETS",
      effect: { main: "/abs/src/site.ts", routes: ["/api/*"] },
    });
    expect(fetchOnly).toContain("makeWebsiteExports(WorkerEntrypoint");
    expect(fetchOnly).not.toContain("DurableObjectBridge");
    expect(fetchOnly).not.toContain("makeWorkflowBridge");
  });
});

describe("matchServerRoutes (runWorkerFirst glob dialect)", () => {
  it("matches * across path segments", () => {
    expect(matchServerRoutes(["/api/*"], "/api/effect/kv")).toBe(true);
    expect(matchServerRoutes(["/api/*"], "/apix")).toBe(false);
    expect(matchServerRoutes(["/api/*"], "/about")).toBe(false);
  });

  it("gives exclusions precedence", () => {
    expect(
      matchServerRoutes(["/api/*", "!/api/public/*"], "/api/public/x"),
    ).toBe(false);
    expect(matchServerRoutes(["/api/*", "!/api/public/*"], "/api/x")).toBe(
      true,
    );
  });
});

describe("scanForExplicitServeMount", () => {
  const dir = NodeFs.mkdtempSync(
    NodePath.join(NodeOs.tmpdir(), "sk-serve-scan-"),
  );
  afterAll(() => {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  });

  it("detects an alchemy/Serve import specifier in emitted chunks", () => {
    const chunks = NodePath.join(dir, "specifier", "chunks");
    NodeFs.mkdirSync(chunks, { recursive: true });
    NodeFs.writeFileSync(
      NodePath.join(chunks, "hooks.server.js"),
      'import { toHandle } from "alchemy/SvelteKit";\n',
    );
    expect(scanForExplicitServeMount(NodePath.join(dir, "specifier"))).toBe(
      true,
    );
  });

  it("detects the bundled explicit-mount marker literal", () => {
    const root = NodePath.join(dir, "sentinel");
    NodeFs.mkdirSync(root, { recursive: true });
    NodeFs.writeFileSync(
      NodePath.join(root, "index.js"),
      'globalThis["__ALCHEMY_SERVE_MOUNT_v1__"]=true;\n',
    );
    expect(scanForExplicitServeMount(root)).toBe(true);
  });

  it("ignores the bridge's own sentinel literal (value-form client graph)", () => {
    // The runtime bridge (`Serve/Bridge.ts`, which stamps
    // `__ALCHEMY_SERVE_v1__`) rides the value-form `createClient` graph —
    // `+page.server.ts` importing the backend bundles it into EVERY
    // effectful website's kit server output. Its literal must NOT read as
    // an explicit mount, or the auto tier stands down on every site that
    // server-renders a backend value.
    const root = NodePath.join(dir, "bridge-only");
    NodeFs.mkdirSync(root, { recursive: true });
    NodeFs.writeFileSync(
      NodePath.join(root, "index.js"),
      'globalThis["__ALCHEMY_SERVE_v1__"]=true;\n',
    );
    expect(scanForExplicitServeMount(root)).toBe(false);
  });

  it("stays quiet for a server graph without a mount", () => {
    const root = NodePath.join(dir, "clean");
    NodeFs.mkdirSync(root, { recursive: true });
    NodeFs.writeFileSync(
      NodePath.join(root, "index.js"),
      'export const handle = () => new Response("ok");\n',
    );
    // non-JS files are never read
    NodeFs.writeFileSync(
      NodePath.join(root, "notes.txt"),
      "alchemy/Serve is mentioned in prose only",
    );
    expect(scanForExplicitServeMount(root)).toBe(false);
  });
});
