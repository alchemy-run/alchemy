import { describe, expect, it } from "vitest";
import {
  makeEffectEntrySource,
  makeTakeoverWorkerSource,
  probeOpenNextDoExports,
  TAKEOVER_ENTRY_NAME,
} from "../EffectBundle.ts";
import { effectEntryOf } from "../source.ts";

describe("EffectBundle", () => {
  it("probes exactly the DO classes the OpenNext worker exports", () => {
    expect(
      probeOpenNextDoExports(
        `export { DOQueueHandler } from "./.build/durable-objects/queue.js";`,
      ),
    ).toEqual(["DOQueueHandler"]);
    expect(probeOpenNextDoExports(`export default { fetch() {} };`)).toEqual(
      [],
    );
    expect(
      probeOpenNextDoExports(
        `export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./x.js";`,
      ),
    ).toEqual(["DOQueueHandler", "DOShardedTagCache", "BucketCachePurge"]);
  });

  it("grafts the OpenNext handler verbatim via makeWebsiteEntryExports (additive)", () => {
    const source = makeEffectEntrySource(
      {
        mainPath: "/app/src/site.ts",
        routes: ["/api/*"],
        doClasses: ["Counter"],
        wfClasses: [],
      },
      "/app/src/site.ts",
    );
    expect(source).toContain(`import Site from "/app/src/site.ts";`);
    expect(source).toContain(
      `import { makeWebsiteEntryExports, DurableObjectBridge } from "alchemy/Serve/Worker";`,
    );
    expect(source).toContain("makeWebsiteEntryExports(WorkerEntrypoint, {");
    // The framework handler — with the user's route-file mount compiled
    // inside it — IS the one fetch handler; the wrapper never route-gates.
    expect(source).toContain(
      "fetch: (request, env, ctx) => framework.fetch(request, env, ctx),",
    );
    expect(source).not.toContain("makeWebsiteExports(");
    expect(source).not.toContain("routes:");
    expect(source).toContain(
      `export class Counter extends __AlchemyDurableObjectBridge("Counter") {}`,
    );
    expect(source).not.toContain("WorkflowBridge");
  });

  it("re-exports Workflow bridge classes (lazy stack identity)", () => {
    const source = makeEffectEntrySource(
      {
        mainPath: "/app/src/site.ts",
        doClasses: [],
        wfClasses: ["ReportWorkflow"],
      },
      "/app/src/site.ts",
    );
    expect(source).toContain(
      `import { makeWebsiteEntryExports, WorkflowBridge } from "alchemy/Serve/Worker";`,
    );
    expect(source).toContain(
      "const __AlchemyWorkflowBridge = WorkflowBridge(WorkflowEntrypoint, { site: Site });",
    );
    expect(source).toContain(
      `export class ReportWorkflow extends __AlchemyWorkflowBridge("ReportWorkflow") {}`,
    );
    expect(source).not.toContain("DurableObjectBridge");
  });

  it("generates the takeover wrapper re-exporting probed + effect classes", () => {
    const wrapper = makeTakeoverWorkerSource({
      openNextDoExports: ["DOQueueHandler"],
      effectDoClasses: ["Counter"],
      effectWfClasses: ["ReportWorkflow"],
    });
    expect(wrapper).toContain(`import framework from "./worker.js";`);
    expect(wrapper).toContain(`export { DOQueueHandler } from "./worker.js";`);
    expect(wrapper).toContain(
      `export { Counter, ReportWorkflow } from "./alchemy-effect/alchemy-effect.mjs";`,
    );
    expect(wrapper).toContain(`export default makeAlchemyWorker(framework);`);
    // Additive: the OpenNext handler is passed verbatim — never a lazy
    // route-gated thunk.
    expect(wrapper).not.toContain("() => import(");
    // No spurious export lists when nothing is probed.
    const bare = makeTakeoverWorkerSource({
      openNextDoExports: [],
      effectDoClasses: [],
      effectWfClasses: [],
    });
    expect(bare).not.toContain("export {");
  });

  it("effectEntryOf classifies exports and requires a wrapper mainPath", () => {
    expect(
      effectEntryOf({
        id: "x",
        workerName: "x",
        compatibility: { date: "2026-05-12", flags: [] },
        entry: { kind: "external" },
      }),
    ).toBeUndefined();
    expect(
      effectEntryOf({
        id: "x",
        workerName: "x",
        compatibility: { date: "2026-05-12", flags: [] },
        entry: {
          kind: "effect",
          exports: {
            Counter: { kind: "durableObject" },
            Flow: { kind: "workflow" },
          },
          routes: ["/api/*"],
          mainPath: "/app/src/site.ts",
        },
      }),
    ).toEqual({
      mainPath: "/app/src/site.ts",
      routes: ["/api/*"],
      doClasses: ["Counter"],
      wfClasses: ["Flow"],
    });
    expect(TAKEOVER_ENTRY_NAME).toBe("alchemy-worker.js");
  });
});
