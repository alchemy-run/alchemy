import { Auth } from "@alchemy.run/neon/Auth";
import { Branch } from "@alchemy.run/neon/Branch";
import { DataApi } from "@alchemy.run/neon/DataApi";
import { Function } from "@alchemy.run/neon/Function";
import { Project } from "@alchemy.run/neon/Project";
import { providers } from "@alchemy.run/neon/Providers";
import { Role } from "@alchemy.run/neon/Role";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import { getProject, getProjectBranch } from "@distilled.cloud/neon";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

const { test } = Test.make({ providers: providers() });

const tags = ["provider:neon", "provider:neon:project", "provider:neon:branch", "live"];

// The target belongs to another stack, as a lookup's target always should.
const target = () => Core.scratchStack({ providers: providers() }, "NeonLookupTarget");

describe.concurrent("lookup", () => {
  test.provider(
    "a looked-up Project holds a declared Branch and survives its destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const owner = target();
        yield* owner.destroy();
        const project = yield* owner.deploy(Project("LookupTarget"));

        const program = Branch("OnLookedUpProject", {
          project: Project.lookup({ projectId: project.projectId }),
        });
        const branch = yield* stack.deploy(program);
        expect(branch.projectId).toEqual(project.projectId);
        const stored = yield* getProjectBranch({
          project_id: project.projectId,
          branch_id: branch.branchId,
        });
        expect(stored.branch.id).toEqual(branch.branchId);

        // A lookup re-resolves to the same Project.
        const plan = yield* stack.plan(program);
        expect(plan.resources.OnLookedUpProject?.action).toEqual("noop");

        // Destroying the consumer removes the Branch, never the Project.
        yield* stack.destroy();
        const after = yield* getProject({ project_id: project.projectId });
        expect(after.project.id).toEqual(project.projectId);
        const gone = yield* getProjectBranch({
          project_id: project.projectId,
          branch_id: branch.branchId,
        }).pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
        expect(gone).toEqual("gone");

        yield* owner.destroy();
      }),
    { tags, timeout: 300_000 },
  );

  test.provider(
    "a lookup of a resource that doesn't exist fails the plan",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const owner = target();
        yield* owner.destroy();
        // Children are looked up in a project that exists, so only the child
        // itself is missing.
        const project = yield* owner.deploy(Project("LookupMissingTarget"));
        const projectId = project.projectId;

        const lookups = {
          Project: Project.lookup({ projectId: "alchemy-missing-project-0000" }),
          Branch: Branch.lookup({ projectId, branchId: "br-alchemy-missing-00000000" }),
          Role: Role.lookup({ projectId, roleName: "alchemy_missing" }),
          Auth: Auth.lookup({ projectId }),
          DataApi: DataApi.lookup({ projectId, database: "alchemy_missing" }),
          Function: Function.lookup({ projectId, slug: "alchemymissing" }),
        } as unknown as Record<string, Output.Output<unknown>>;

        const mismatches: Record<string, string> = {};
        for (const [id, lookup] of Object.entries(lookups)) {
          const exit = yield* Effect.exit(
            stack.plan(Project(id, { defaultBranchName: Output.interpolate`${lookup}` })),
          );
          const pretty = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "plan succeeded";
          if (!pretty.includes("LookupNotFoundError")) {
            mismatches[id] = pretty.split("\n")[0]!.slice(0, 300);
          }
        }
        expect(mismatches).toEqual({});

        yield* owner.destroy();
      }),
    { tags, timeout: 300_000 },
  );
});
