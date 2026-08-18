import { describe, expect, it } from "vitest";
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

  it("grafts kit's handler verbatim via makeWebsiteEntryExports (additive)", () => {
    expect(effect).toContain(
      `import { makeWebsiteEntryExports, DurableObjectBridge, WorkflowBridge } from "alchemy/Cloudflare/Serve";`,
    );
    expect(effect).toContain(
      `import __alchemy_site from "/abs/project/src/site.ts";`,
    );
    expect(effect).toContain(
      "export default makeWebsiteEntryExports(WorkerEntrypoint, {",
    );
    // Kit's handler — with the user's hooks.server.ts mount inside — IS
    // the one fetch handler; the shim never route-gates or intercepts.
    expect(effect).toContain(
      "fetch: (request, env, ctx) => kit_handler.fetch(request, env, ctx),",
    );
    expect(effect).not.toContain("makeWebsiteExports(");
    expect(effect).not.toContain("routes:");
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

  it("re-exports Workflow bridge classes (lazy stack identity)", () => {
    // WorkflowBridge resolves the stack from env markers at layer-build
    // time (lazyStack) — nothing is baked into the shim.
    expect(effect).toContain(
      "const __alchemyWorkflowBridge = WorkflowBridge(WorkflowEntrypoint, { site: __alchemy_site });",
    );
    expect(effect).toContain(
      'export class Flow extends __alchemyWorkflowBridge("Flow") {}',
    );
    expect(effect).not.toContain("makeWorkflowBridge");
    expect(effect).not.toContain("stack: {");
  });

  it("omits DO/Workflow scaffolding when the site exports none", () => {
    const fetchOnly = generateWorkerShim({
      serverImport: "./server/index.js",
      manifestImport: "./manifest.js",
      assetsBinding: "ASSETS",
      effect: { main: "/abs/src/site.ts", routes: ["/api/*"] },
    });
    expect(fetchOnly).toContain("makeWebsiteEntryExports(WorkerEntrypoint");
    expect(fetchOnly).not.toContain("DurableObjectBridge");
    expect(fetchOnly).not.toContain("makeWorkflowBridge");
  });
});
