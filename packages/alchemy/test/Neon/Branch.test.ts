import * as Neon from "@/Neon";
import * as Provider from "@/Provider";
import type { ScopedPlanStatusSession } from "@/Cli/Cli.ts";
import * as Test from "@/Test/Vitest";
import { deleteProject, getProjectBranch } from "@distilled.cloud/neon";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Neon.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stubSession = {
  note: () => Effect.void,
} as unknown as ScopedPlanStatusSession;

test.provider("changing project replaces the branch", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const projectA = yield* Neon.Project("ReplaceBranchProjectA");
        const projectB = yield* Neon.Project("ReplaceBranchProjectB");
        const branch = yield* Neon.Branch("ReplaceBranch", {
          project: projectA,
        });
        return { projectA, projectB, branch };
      }),
    );

    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        const projectA = yield* Neon.Project("ReplaceBranchProjectA");
        const projectB = yield* Neon.Project("ReplaceBranchProjectB");
        const branch = yield* Neon.Branch("ReplaceBranch", {
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

test.provider(
  "reconcile recreates a branch when cached project is gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const projectA = yield* Neon.Project("StaleBranchProjectA");
          const projectB = yield* Neon.Project("StaleBranchProjectB");
          const branch = yield* Neon.Branch("StaleBranch", {
            project: projectA,
          });
          return { projectA, projectB, branch };
        }),
      );

      yield* deleteProject({ project_id: initial.projectA.projectId });

      const provider = yield* Provider.findProvider(Neon.Branch);
      const reconciled = yield* provider.reconcile({
        id: "StaleBranch",
        instanceId: "stale-branch",
        news: { project: initial.projectB },
        olds: { project: initial.projectA },
        output: initial.branch,
        session: stubSession,
        bindings: [],
      });

      expect(reconciled.projectId).toEqual(initial.projectB.projectId);
      expect(reconciled.branchId).not.toEqual(initial.branch.branchId);

      const fetched = yield* getProjectBranch({
        project_id: initial.projectB.projectId,
        branch_id: reconciled.branchId,
      });
      expect(fetched.branch.id).toEqual(reconciled.branchId);
    }).pipe(logLevel, Effect.ensuring(stack.destroy())),
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
