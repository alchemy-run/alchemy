import * as Neon from "@/Neon";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { getProjectBranch } from "@distilled.cloud/neon";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Neon.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Canonical `list()` test (parent fan-out): branches are scoped to a project
// and there is no account-wide branch enumeration API, so `list()` enumerates
// every project and lists+hydrates the branches of each. Deploy a project +
// branch, then assert the deployed branch appears in the exhaustive result.
test.provider("list enumerates the deployed branch", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { project, branch } = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Neon.Project("ListBranchProject");
        const branch = yield* Neon.Branch("ListBranch", { project });
        return { project, branch };
      }),
    );

    const provider = yield* Provider.findProvider(Neon.Branch);
    const all = yield* provider.list();

    const found = all.find((b) => b.branchId === branch.branchId);
    expect(found).toBeDefined();
    expect(found?.projectId).toEqual(project.projectId);
    expect(found?.branchName).toEqual(branch.branchName);
    expect(found?.connectionUri).toContain("postgres");

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider(
  "updating project in-place does not replace the branch",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Neon.Project("UpdateBranchProject", {
            enableLogicalReplication: false,
          });
          const branch = yield* Neon.Branch("UpdateBranch", {
            project,
          });
          return { project, branch };
        }),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Neon.Project("UpdateBranchProject", {
            enableLogicalReplication: true,
          });
          const branch = yield* Neon.Branch("UpdateBranch", {
            project,
          });
          return { project, branch };
        }),
      );

      expect(updated.branch.projectId).toEqual(updated.project.projectId);
      expect(updated.branch.branchId).toEqual(initial.branch.branchId);

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "replaces branch when project changes to another pre-existing project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const projectA = yield* Neon.Project("ReplaceBranchProjectA");
          const projectB = yield* Neon.Project("ReplaceBranchProjectB");
          const branch = yield* Neon.Branch("ReplaceBranchExistingProject", {
            project: projectA,
          });
          return { projectA, projectB, branch };
        }),
      );

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const projectA = yield* Neon.Project("ReplaceBranchProjectA");
          const projectB = yield* Neon.Project("ReplaceBranchProjectB");
          const branch = yield* Neon.Branch("ReplaceBranchExistingProject", {
            project: projectB,
          });
          return { projectA, projectB, branch };
        }),
      );

      expect(replaced.branch.projectId).toEqual(replaced.projectB.projectId);
      expect(replaced.branch.branchId).not.toEqual(initial.branch.branchId);

      const fetched = yield* getProjectBranch({
        project_id: replaced.projectB.projectId,
        branch_id: replaced.branch.branchId,
      });
      expect(fetched.branch.id).toEqual(replaced.branch.branchId);

      const oldBranch = yield* getProjectBranch({
        project_id: initial.projectA.projectId,
        branch_id: initial.branch.branchId,
      }).pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("not-found" as const)),
      );
      expect(oldBranch).toEqual("not-found");

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider("replaces branch when project is replaced", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Neon.Project("ReplaceProject", {
          region: "aws-us-east-1",
        });
        const branch = yield* Neon.Branch("ReplaceBranchReplaceProject", {
          project,
        });
        return { project, branch };
      }),
    );

    expect(initial.project.region).toEqual("aws-us-east-1");

    // Trigger a replace on the project by changing the region.
    // This should cause the branch to be replaced.
    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Neon.Project("ReplaceProject", {
          region: "aws-us-west-2",
        });
        const branch = yield* Neon.Branch("ReplaceBranchReplaceProject", {
          project,
        });
        return { project, branch };
      }),
    );

    expect(replaced.project.region).toEqual("aws-us-west-2");
    expect(replaced.branch.projectId).toEqual(replaced.project.projectId);
    expect(replaced.branch.projectId).not.toEqual(initial.project.projectId);
    expect(replaced.branch.branchId).not.toEqual(initial.branch.branchId);

    const fetched = yield* getProjectBranch({
      project_id: replaced.project.projectId,
      branch_id: replaced.branch.branchId,
    });
    expect(fetched.branch.id).toEqual(replaced.branch.branchId);

    const oldBranch = yield* getProjectBranch({
      project_id: initial.project.projectId,
      branch_id: initial.branch.branchId,
    }).pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("not-found" as const)),
    );
    expect(oldBranch).toEqual("not-found");

    yield* stack.destroy();
  }).pipe(logLevel),
);
