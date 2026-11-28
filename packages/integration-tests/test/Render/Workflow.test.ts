import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { expectAllNoop, makeRenderTest } from "./common.ts";

const t = makeRenderTest();

const workflowRepo = process.env.RENDER_TEST_WORKFLOW_REPO;

describe("Render.Workflow", { tags: ["provider:render", "live"], timeout: 120_000 }, () => {
  t.test.provider(
    "lists Workflows on the workspace cleanly",
    () =>
      Effect.gen(function* () {
        const prov = yield* Provider.findProvider(Render.Workflow);
        const list = yield* prov.list!();
        expect(Array.isArray(list)).toBe(true);
      }),
    { tags: ["provider:render", "live"], timeout: 60_000 },
  );

  t.test.provider.skipIf(!workflowRepo)(
    "creates, updates, and destroys a Workflow when RENDER_TEST_WORKFLOW_REPO is set",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const program = (runCommand: string) =>
          Render.Workflow("LiveWorkflow", {
            region: "oregon",
            runtime: "node",
            repo: workflowRepo!,
            branch: "main",
            buildCommand: "pnpm install && pnpm build",
            runCommand,
          });

        const prov = yield* Provider.findProvider(Render.Workflow);
        const created = yield* stack.deploy(program("node dist/index.js"));
        expect(created.id).toMatch(/^wfl-/);

        yield* expectAllNoop(stack, program("node dist/index.js"));

        const updated = yield* stack.deploy(program("node dist/worker.js"));
        expect(updated.id).toBe(created.id);
        expect(updated.runCommand).toBe("node dist/worker.js");

        yield* stack.destroy();
        expect(yield* prov.lookup!({ id: created.id })).toBeUndefined();
      }),
    { tags: ["provider:render", "live"], timeout: 120_000 },
  );
});
