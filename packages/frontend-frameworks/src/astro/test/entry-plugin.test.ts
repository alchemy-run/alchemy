import { describe, expect, it } from "vitest";
import { makeEntryWrapperSource } from "../entry-plugin.ts";

describe("makeEntryWrapperSource (Astro entry takeover)", () => {
  const wrapper = makeEntryWrapperSource({
    entryId: "/abs/node_modules/ff/dist/astro/runtime/entrypoints/server.js",
    mainPath: "/abs/project/site.ts",
    doClasses: ["Counter", "Rooms"],
  });

  it("delegates fetch verbatim to the vendored astro entry", () => {
    expect(wrapper).toContain(
      `import __astroEntry from "/abs/node_modules/ff/dist/astro/runtime/entrypoints/server.js";`,
    );
    expect(wrapper).toContain(
      "fetch: (request, env, ctx) => __astroEntry.fetch(request, env, ctx),",
    );
    // The entry never re-bridges fetch: no route-gated wrapper, no
    // framework-fallback composition — that stays inside the fetchable.
    expect(wrapper).not.toContain("makeWebsiteExports(");
    expect(wrapper).not.toContain("routes:");
  });

  it("spreads the non-fetch handler surface from the Worker bridge", () => {
    expect(wrapper).toContain(
      `import { makeWebsiteEntryExports, DurableObjectBridge } from "alchemy/Serve/Worker";`,
    );
    expect(wrapper).toContain(`import Site from "/abs/project/site.ts";`);
    expect(wrapper).toContain(
      "export default makeWebsiteEntryExports(WorkerEntrypoint, {",
    );
    expect(wrapper).toContain("globalThis.__ALCHEMY_RUNTIME__ = true;");
  });

  it("re-exports Durable Object bridge classes", () => {
    expect(wrapper).toContain(
      "const __alchemyDurableObjectBridge = DurableObjectBridge(DurableObject, { site: Site });",
    );
    expect(wrapper).toContain(
      'export class Counter extends __alchemyDurableObjectBridge("Counter") {}',
    );
    expect(wrapper).toContain(
      'export class Rooms extends __alchemyDurableObjectBridge("Rooms") {}',
    );
  });

  it("omits DO scaffolding when the site exports none", () => {
    const fetchAndEvents = makeEntryWrapperSource({
      entryId: "/abs/server.js",
      mainPath: "/abs/site.ts",
      doClasses: [],
    });
    expect(fetchAndEvents).toContain(
      "makeWebsiteEntryExports(WorkerEntrypoint",
    );
    expect(fetchAndEvents).not.toContain("DurableObjectBridge");
    expect(fetchAndEvents).not.toContain("DurableObject ");
  });
});
