import { describe, expect, it } from "vitest";
import {
  NITRO_AWS_STREAMING_HANDLER_SPECIFIER,
  renderAwsLambdaEntry,
} from "../aws.ts";
import { makeEffectEntrySource, renderWorkerEntry } from "../effect.ts";

describe("makeEffectEntrySource (additive wrapper)", () => {
  const source = makeEffectEntrySource({
    sitePath: "/abs/project/src/site.ts",
    durableObjects: ["Counter", "Registry"],
    workflows: ["ReportWorkflow"],
  });

  it("grafts the framework's fetch verbatim via makeWebsiteEntryExports", () => {
    expect(source).toContain(
      'import { makeWebsiteEntryExports, DurableObjectBridge, WorkflowBridge } from "alchemy/Cloudflare/Serve";',
    );
    expect(source).toContain('import Site from "/abs/project/src/site.ts";');
    expect(source).toContain("makeWebsiteEntryExports(WorkerEntrypoint, {");
    // ADDITIVE-ONLY: no routes baked in, no route gating — the user's
    // server middleware mount owns HTTP.
    expect(source).not.toContain("routes");
    expect(source).not.toContain("makeWebsiteExports(");
  });

  it("resolves the lazy framework loader (default/fetch/callable)", () => {
    expect(source).toContain("framework?.() ?? Promise.resolve(undefined)");
    expect(source).toContain("mod?.default ?? mod");
    expect(source).toContain("target.fetch.bind(target)");
  });

  it("exports Durable Object bridge classes", () => {
    expect(source).toContain(
      "const __AlchemyDurableObjectBridge = DurableObjectBridge(DurableObject, { site: Site });",
    );
    expect(source).toContain(
      'export class Counter extends __AlchemyDurableObjectBridge("Counter") {}',
    );
    expect(source).toContain(
      'export class Registry extends __AlchemyDurableObjectBridge("Registry") {}',
    );
  });

  it("exports Workflow bridge classes (lazy stack identity)", () => {
    expect(source).toContain(
      "const __AlchemyWorkflowBridge = WorkflowBridge(WorkflowEntrypoint, { site: Site });",
    );
    expect(source).toContain(
      'export class ReportWorkflow extends __AlchemyWorkflowBridge("ReportWorkflow") {}',
    );
    expect(source).toContain(
      'import { DurableObject, WorkerEntrypoint, WorkflowEntrypoint } from "cloudflare:workers";',
    );
  });

  it("omits DO/Workflow scaffolding when the site exports none", () => {
    const bare = makeEffectEntrySource({
      sitePath: "/abs/src/site.ts",
      durableObjects: [],
      workflows: [],
    });
    expect(bare).toContain("makeWebsiteEntryExports(WorkerEntrypoint");
    expect(bare).not.toContain("DurableObjectBridge");
    expect(bare).not.toContain("WorkflowBridge");
    expect(bare).toContain(
      'import { WorkerEntrypoint } from "cloudflare:workers";',
    );
  });

  it("rejects class names that are not identifiers", () => {
    expect(() =>
      makeEffectEntrySource({
        sitePath: "/abs/src/site.ts",
        durableObjects: ["not-an-identifier"],
        workflows: [],
      }),
    ).toThrow(/not a valid JavaScript identifier/);
  });
});

describe("renderWorkerEntry", () => {
  it("re-exports DO and Workflow classes from the prebundle", () => {
    const entry = renderWorkerEntry({
      durableObjects: ["Counter"],
      workflows: ["ReportWorkflow"],
    });
    expect(entry).toContain(
      'export { Counter, ReportWorkflow } from "alchemy:nuxt-effect";',
    );
    expect(entry).toContain(
      "export default makeAlchemyWorker(() => Promise.resolve({ default: nitroHandler }));",
    );
  });

  it("degenerates to the plain wrapper without classes", () => {
    const entry = renderWorkerEntry({ durableObjects: [], workflows: [] });
    expect(entry).not.toContain("export {");
    expect(entry).toContain("makeAlchemyWorker(");
  });
});

describe("renderAwsLambdaEntry (AWS single-handler delivery)", () => {
  const source = renderAwsLambdaEntry({
    sitePath: "/abs/project/server/backend.ts",
  });

  it("grafts nitro's streaming handler verbatim as a pre-streamified delegate", () => {
    expect(source).toContain(
      `import { handler as nitroHandler } from ${JSON.stringify(
        NITRO_AWS_STREAMING_HANDLER_SPECIFIER,
      )};`,
    );
    expect(source).toContain("streamHandler: nitroHandler");
  });

  it("builds the composite handler from alchemy/AWS/Serve over the site module", () => {
    expect(source).toContain(
      'import { makeFrameworkFunctionHandler } from "alchemy/AWS/Serve";',
    );
    expect(source).toContain(
      'import Site from "/abs/project/server/backend.ts";',
    );
    expect(source).toContain(
      "export const handler = await makeFrameworkFunctionHandler({",
    );
    expect(source).toContain("site: Site,");
  });

  it("is ADDITIVE-ONLY: no routes baked in, no route gating, no middleware", () => {
    expect(source).not.toContain("routes");
    expect(source).not.toContain("__is_handler__");
  });
});
