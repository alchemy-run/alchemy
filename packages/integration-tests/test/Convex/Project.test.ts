import * as Convex from "@alchemy.run/convex";
import { team } from "@alchemy.run/convex/Credentials";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as management from "@distilled.cloud/convex/management";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { isActionState, State } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { projectsNamed, testName } from "./support.ts";

const { test } = Test.make({ providers: Convex.providers() });
const options = { timeout: 120_000 };

const App = (props: Convex.ProjectProps) =>
  Convex.Project("App", props).pipe(RemovalPolicy.destroy());

test.provider(
  "creates a project with no deployments",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("project-create");

      const project = yield* stack.deploy(App({ name }));
      expect(project.name).toBe(name);
      expect(yield* management.listDeployments({ projectId: project.projectId })).toEqual([]);

      const observed = yield* management.getProject({ projectId: project.projectId });
      expect(observed.tags?.some((tag) => tag.startsWith("alchemy-"))).toBe(true);

      yield* stack.destroy();
      expect(yield* projectsNamed(name)).toEqual([]);
    }),
  options,
);

test.provider(
  "generates a name when none is given",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const project = yield* stack.deploy(App({}));
      expect(project.name.length).toBeGreaterThan(0);
      const generated = project.name;
      yield* stack.destroy();
      expect(yield* projectsNamed(generated)).toEqual([]);
    }),
  options,
);

test.provider(
  "takes no props at all",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const project = yield* stack.deploy(Convex.Project("App").pipe(RemovalPolicy.destroy()));
      expect(project.name.length).toBeGreaterThan(0);
      const redeployed = yield* stack.deploy(Convex.Project("App").pipe(RemovalPolicy.destroy()));
      expect(redeployed.projectId).toBe(project.projectId);
      yield* stack.destroy();
      expect(yield* projectsNamed(project.name)).toEqual([]);
    }),
  options,
);

test.provider(
  "renames in place and keeps user tags beside the ownership tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("project-rename");
      const renamed = `${name}-2`;

      const before = yield* stack.deploy(App({ name, tags: ["one"] }));
      const after = yield* stack.deploy(App({ name: renamed, tags: ["two"] }));
      expect(after.projectId).toBe(before.projectId);

      const observed = yield* management.getProject({ projectId: after.projectId });
      expect(observed.name).toBe(renamed);
      expect(observed.tags).toContain("two");
      expect(observed.tags).not.toContain("one");
      expect(observed.tags?.some((tag) => tag.startsWith("alchemy-"))).toBe(true);

      yield* stack.destroy();
      expect(yield* projectsNamed(renamed)).toEqual([]);
    }),
  options,
);

test.provider(
  "redeploys without creating a twin",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("project-twin");

      const first = yield* stack.deploy(App({ name }));
      const second = yield* stack.deploy(App({ name }));
      expect(second.projectId).toBe(first.projectId);
      expect(yield* projectsNamed(name)).toHaveLength(1);

      yield* stack.destroy();
      expect(yield* projectsNamed(name)).toEqual([]);
    }),
  options,
);

test.provider(
  "refuses an unowned project of the same name, and adopts it when allowed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("project-unowned");
      const foreign = yield* management.createProject({
        teamId: yield* team,
        projectName: name,
      });

      const refused = yield* stack.deploy(App({ name }).pipe(adopt(false))).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);
      expect(yield* projectsNamed(name)).toHaveLength(1);

      const adopted = yield* stack.deploy(App({ name }).pipe(adopt(true)));
      expect(adopted.projectId).toBe(foreign.projectId);

      yield* stack.destroy();
      expect(yield* projectsNamed(name)).toEqual([]);
    }),
  options,
);

test.provider(
  "retain is the default",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("project-retain");

      const project = yield* stack.deploy(Convex.Project("App", { name }));
      yield* stack.destroy();

      const observed = yield* management.getProject({ projectId: project.projectId });
      expect(observed.name).toBe(name);

      yield* management.deleteProject({ projectId: project.projectId });
      expect(yield* projectsNamed(name)).toEqual([]);
    }),
  options,
);

test.provider(
  "delete refuses while a prod deployment exists",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("project-prod");

      const project = yield* stack.deploy(App({ name }));
      const prod = yield* management.createDeployment({
        projectId: project.projectId,
        type: "prod",
      });

      const refused = yield* stack.destroy().pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      expect(yield* projectsNamed(name)).toHaveLength(1);

      yield* management.deleteDeployment({ deploymentName: prod.name });
      yield* stack.destroy();
      expect(yield* projectsNamed(name)).toEqual([]);
    }),
  options,
);

test.provider(
  "destroy removes a project whose create never recorded attributes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("project-recover");

      yield* stack.deploy(App({ name }));

      // Reproduce a crash after the create but before attributes were committed.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        const address = { stack: stack.name, stage: stack.stage, fqn: "App" };
        const stored = yield* state.get(address);
        if (!stored || isActionState(stored) || stored.status !== "created") {
          return yield* Effect.die(new Error("Expected a created project row"));
        }
        const { attr, ...creating } = stored;
        yield* state.set({ ...address, value: { ...creating, status: "creating" } });
      }).pipe(Effect.provide(stack.state));

      yield* stack.destroy();
      expect(yield* projectsNamed(name)).toEqual([]);
    }),
  options,
);

test.provider(
  "delete fails when the token can't see the project's team",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("project-team");

      const project = yield* stack.deploy(App({ name }));

      const setTeam = (teamId: number) =>
        Effect.gen(function* () {
          const state = yield* yield* State;
          const address = { stack: stack.name, stage: stack.stage, fqn: "App" };
          const stored = yield* state.get(address);
          if (!stored || isActionState(stored) || !("attr" in stored) || !stored.attr) {
            return yield* Effect.die(new Error("Expected a project row with attributes"));
          }
          yield* state.set({
            ...address,
            value: { ...stored, attr: { ...stored.attr, teamId } },
          });
        }).pipe(Effect.provide(stack.state));

      // A 404 from another team must not read as "gone" and drop the row.
      yield* setTeam(1);
      const refused = yield* stack.destroy().pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      expect(yield* projectsNamed(name)).toHaveLength(1);

      yield* setTeam(project.teamId);
      yield* stack.destroy();
      expect(yield* projectsNamed(name)).toEqual([]);
    }),
  options,
);

test.provider(
  "a deploy fails rather than making a twin when the token can't see the project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("project-team-deploy");
      const project = yield* stack.deploy(App({ name }));

      const setAttrs = (attrs: Record<string, unknown>) =>
        Effect.gen(function* () {
          const state = yield* yield* State;
          const address = { stack: stack.name, stage: stack.stage, fqn: "App" };
          const stored = yield* state.get(address);
          if (!stored || isActionState(stored) || !("attr" in stored) || !stored.attr) {
            return yield* Effect.die(new Error("Expected a project row with attributes"));
          }
          yield* state.set({
            ...address,
            value: { ...stored, attr: { ...stored.attr, ...attrs } },
          });
        }).pipe(Effect.provide(stack.state));

      // Another team's project answers 404, exactly like one that was deleted.
      yield* setAttrs({ teamId: 1, projectId: 1 });
      const refused = yield* stack.deploy(App({ name, tags: ["changed"] })).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      expect(yield* projectsNamed(name)).toHaveLength(1);

      yield* setAttrs({ teamId: project.teamId, projectId: project.projectId });
      yield* stack.destroy();
      expect(yield* projectsNamed(name)).toEqual([]);
    }),
  options,
);

test.provider("types a missing project", () =>
  Effect.gen(function* () {
    const error = yield* management.getProject({ projectId: 1 }).pipe(Effect.flip);
    expect(error._tag).toBe("ProjectNotFound");
  }),
);
