import * as Convex from "@alchemy.run/convex";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as convex from "@distilled.cloud/convex/convex";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { testName } from "./support.ts";

const { test } = Test.make({ providers: Convex.providers() });

const app = (
  name: string,
  env: Convex.DefaultEnvironmentVariablesProps["env"],
  deploymentTypes?: Convex.DefaultEnvironmentVariablesProps["deploymentTypes"],
) =>
  Effect.gen(function* () {
    const project = yield* Convex.Project("App", { name }).pipe(RemovalPolicy.destroy());
    yield* Convex.DefaultEnvironmentVariables("Defaults", { project, env, deploymentTypes });
    return project;
  });

const defaults = (projectId: number) =>
  convex
    .listDefaultEnvironmentVariables({ project_id: projectId })
    .pipe(
      Effect.map((response) =>
        Object.fromEntries(
          response.items.map((item) => [
            item.name,
            [item.value, [...item.deploymentTypes].toSorted()],
          ]),
        ),
      ),
    );

const ALL = ["dev", "preview", "prod"];

test.provider(
  "sets, changes and removes defaults, and keeps one set by hand",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("defaults");
      const project = yield* stack.deploy(app(name, { A: "1", B: Redacted.make("2") }));
      expect(yield* defaults(project.projectId)).toEqual({ A: ["1", ALL], B: ["2", ALL] });

      yield* convex.updateDefaultEnvironmentVariables({
        project_id: project.projectId,
        changes: [{ name: "HAND", deploymentType: "dev", value: "kept" }],
      });

      yield* stack.deploy(app(name, { A: "3" }));
      expect(yield* defaults(project.projectId)).toEqual({
        A: ["3", ALL],
        HAND: ["kept", ["dev"]],
      });

      yield* stack.deploy(app(name, { A: "3" }, ["prod"]));
      expect(yield* defaults(project.projectId)).toEqual({
        A: ["3", ["prod"]],
        HAND: ["kept", ["dev"]],
      });

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);

test.provider(
  "a preview gets the defaults",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("defaults-preview");
      const project = yield* stack.deploy(app(name, { A: "1" }, ["preview"]));
      expect(yield* defaults(project.projectId)).toEqual({ A: ["1", ["preview"]] });
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
