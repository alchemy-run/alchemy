import { BunServices } from "@effect/platform-bun";
import { expect, test } from "bun:test";
import * as AI from "alchemy/AI";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { Coding, CodingLocal } from "../src/skills/Coding.ts";
import { LiveTestingLive } from "../src/skills/LiveTesting.ts";
import { ResourceEngineeringLive } from "../src/skills/ResourceEngineering.ts";
import { TypedErrorsLive } from "../src/skills/TypedErrors.ts";
import { fixed as workspace } from "alchemy/Workspace";
import * as Model from "./fixtures/ScriptedModel.ts";

class CodingAgent extends AI.Agent<CodingAgent>()("CodingAgent") {}

const CodingAgentCharter = AI.prose`
Implement the requested change using ${Coding}.`;

test("Coding skill activates and completes a local grep/read/edit/bash flow", () => {
  const model = Model.make([
    () => [
      Model.toolCall("skill", { action: "activate", skill: "Coding" }),
      Model.finish("tool-calls"),
    ],
    () => [
      Model.toolCall("grep", { pattern: "one = 1", glob: "*.ts" }),
      Model.finish("tool-calls"),
    ],
    () => [
      Model.toolCall("readFile", { path: "src/one.ts" }),
      Model.finish("tool-calls"),
    ],
    (options) => {
      const digest = /SHA-256: ([a-f0-9]{64})/.exec(
        Model.promptText(options),
      )![1]!;
      return [
        Model.toolCall("editFile", {
          path: "src/one.ts",
          expectedDigest: digest,
          edits: [{ oldString: "one = 1", newString: "one = 10" }],
        }),
        Model.finish("tool-calls"),
      ];
    },
    () => [
      Model.toolCall("bash", {
        command: 'grep -q "one = 10" src/one.ts',
      }),
      Model.finish("tool-calls"),
    ],
    () => [Model.text("implemented and verified"), Model.finish()],
  ]);

  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-coding-flow-",
      });
      yield* fs.makeDirectory(path.join(root, ".git"), { recursive: true });
      yield* fs.makeDirectory(path.join(root, "src"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "src", "one.ts"),
        "export const one = 1;\n",
      );

      const Kernel = AI.KernelMemory.pipe(Layer.provide(model.layer));
      const Workspace = workspace(root);
      const LocalCoding = CodingLocal.pipe(
        Layer.provide(Workspace),
        Layer.provide(BunServices.layer),
        // the skill TREE: Coding exposes ResourceEngineering, whose
        // teaching exposes TypedErrors and LiveTesting — every level
        // an OUTPUT so activation can resolve it
        Layer.provideMerge(
          ResourceEngineeringLive.pipe(
            Layer.provideMerge(
              Layer.mergeAll(TypedErrorsLive, LiveTestingLive),
            ),
          ),
        ),
      );
      const AgentLayer = AI.layer(CodingAgent, CodingAgentCharter).pipe(
        Layer.provide(Layer.mergeAll(Kernel, LocalCoding)),
      );
      const Environment = Layer.mergeAll(
        AgentLayer,
        RuntimeContext.phantom,
      ).pipe(Layer.provide(BunServices.layer));

      const answer = yield* Effect.gen(function* () {
        const agent = yield* CodingAgent;
        return yield* agent.dispatch("Change one from 1 to 10 and verify it.");
      }).pipe(Effect.provide(Environment));

      expect(answer).toBe("implemented and verified");
      expect(
        yield* fs.readFileString(path.join(root, "src", "one.ts")),
      ).toContain("one = 10");
      expect(model.calls[0]!.tools.map((tool) => tool.name)).toEqual([
        "spawn",
        "skill",
      ]);
      expect(model.calls[1]!.tools.map((tool) => tool.name)).toContain(
        "editFile",
      );
      expect(Model.promptText(model.calls[5]!)).toContain("exit: 0");
    }).pipe(Effect.provide(BunServices.layer), Effect.scoped),
  );
});
