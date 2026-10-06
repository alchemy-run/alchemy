import { createProjectBranch, updateBranch } from "@distilled.cloud/prisma/management";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Prisma from "@/Prisma";
import * as Test from "@/Test/Alchemy";
import { expectProjectGone, failureOf, forgetState, patchStateAttr } from "./fixtures/Live.ts";
import { expectBranchGone, observeBranch, observeDefaultBranch } from "./fixtures/ResourcesLive.ts";

const { test } = Test.make({ providers: Prisma.providers() });

const tags = ["provider:prisma", "provider:prisma:branch", "provider:prisma:project", "live"];

const projectOnly = Effect.gen(function* () {
  const project = yield* Prisma.Project("Project", { createDatabase: false });
  return { project };
});

const branchStack = (props: { gitName?: string; isDefault?: boolean } = {}) =>
  Effect.gen(function* () {
    const project = yield* Prisma.Project("Project", { createDatabase: false });
    const branch = yield* Prisma.Branch("Preview", {
      project,
      gitName: props.gitName ?? "feature/preview",
      ...(props.isDefault === undefined ? {} : { isDefault: props.isDefault }),
    });
    return { project, branch };
  });

test.provider(
  "creates a preview branch, promotes it, and restores the displaced default when removed",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(branchStack());
    const main = yield* observeDefaultBranch(initial.project.projectId);
    expect(initial.branch.role).toBe("preview");
    expect(initial.branch.isDefault).toBe(false);
    expect(initial.branch.gitName).toBe("feature/preview");
    expect(initial.branch.projectId).toBe(initial.project.projectId);
    expect(initial.branch.previousDefaultBranchId).toBe(main.id);
    expect((yield* observeBranch(initial.branch.branchId)).isDefault).toBe(false);

    const promotePlan = yield* stack.plan(branchStack({ isDefault: true }));
    expect(promotePlan.resources["Preview"]).toMatchObject({ action: "update" });

    const promoted = yield* stack.deploy(branchStack({ isDefault: true }));
    expect(promoted.branch.branchId).toBe(initial.branch.branchId);
    expect(promoted.branch.isDefault).toBe(true);
    // Promotion changes the default, not the immutable preview role.
    expect(promoted.branch.role).toBe("preview");
    expect(promoted.branch.previousDefaultBranchId).toBe(main.id);
    expect((yield* observeBranch(initial.branch.branchId)).isDefault).toBe(true);
    expect((yield* observeBranch(main.id)).isDefault).toBe(false);

    // `false` means "do not promote", never "demote": the API has no demotion.
    const unpromoted = yield* stack.deploy(branchStack({ isDefault: false }));
    expect(unpromoted.branch.branchId).toBe(initial.branch.branchId);
    expect(unpromoted.branch.isDefault).toBe(true);
    expect((yield* observeBranch(initial.branch.branchId)).isDefault).toBe(true);
    expect((yield* observeBranch(main.id)).isDefault).toBe(false);

    const renamePlan = yield* stack.plan(
      branchStack({ gitName: "feature/renamed", isDefault: true }),
    );
    expect(renamePlan.resources["Preview"]).toMatchObject({ action: "replace" });

    // Removing the branch restores the default it displaced before deleting it.
    yield* stack.deploy(projectOnly);
    yield* expectBranchGone(initial.branch.branchId);
    expect((yield* observeBranch(main.id)).isDefault).toBe(true);

    yield* stack.destroy();
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags, timeout: 180_000 },
);

test.provider(
  "refuses to delete a default branch whose displaced default is unknown, then deletes it after repair",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(branchStack());
    const main = yield* observeDefaultBranch(initial.project.projectId);
    expect(initial.branch.isDefault).toBe(false);

    // State still says non-default and no longer records the displaced
    // branch; the branch is promoted out of band. Delete must observe the
    // live default flag and refuse rather than delete the default branch.
    yield* patchStateAttr(stack, "Preview", { previousDefaultBranchId: undefined });
    yield* updateBranch({ branchId: initial.branch.branchId, isDefault: true });

    const refused = yield* failureOf(stack.deploy(projectOnly));
    expect(refused.text).toContain("Cannot safely delete default Prisma branch");
    expect((yield* observeBranch(initial.branch.branchId)).isDefault).toBe(true);

    yield* updateBranch({ branchId: main.id, isDefault: true });
    yield* stack.deploy(projectOnly);
    yield* expectBranchGone(initial.branch.branchId);
    expect((yield* observeBranch(main.id)).isDefault).toBe(true);

    yield* stack.destroy();
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags, timeout: 180_000 },
);

test.provider(
  "deletes a branch whose stale state says it is default",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const promoted = yield* stack.deploy(branchStack({ isDefault: true }));
    expect(promoted.branch.isDefault).toBe(true);
    const main = promoted.branch.previousDefaultBranchId!;

    // Another client promotes the original default back.
    yield* updateBranch({ branchId: main, isDefault: true });
    expect((yield* observeBranch(promoted.branch.branchId)).isDefault).toBe(false);

    yield* stack.deploy(projectOnly);
    yield* expectBranchGone(promoted.branch.branchId);
    expect((yield* observeBranch(main)).isDefault).toBe(true);

    yield* stack.destroy();
    yield* expectProjectGone(promoted.project.projectId);
  }),
  { tags, timeout: 180_000 },
);

test.provider(
  "requires explicit adoption for an existing branch after lost state",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(branchStack());
    yield* forgetState(stack, "Preview");

    const refused = yield* failureOf(stack.deploy(branchStack()));
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);

    const adopted = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const branch = yield* Prisma.Branch("Preview", {
          project,
          gitName: "feature/preview",
        }).pipe(adopt(true));
        return { project, branch };
      }),
    );
    expect(adopted.branch.branchId).toBe(initial.branch.branchId);
    expect(adopted.branch.isDefault).toBe(false);

    yield* stack.destroy();
    yield* expectBranchGone(initial.branch.branchId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags, timeout: 180_000 },
);

test.provider(
  "rejects an App that sets both branchId and branchGitName",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const failure = yield* failureOf(
      stack.deploy(
        Effect.gen(function* () {
          const project = yield* Prisma.Project("Project", { createDatabase: false });
          const branch = yield* Prisma.Branch("Preview", { project, gitName: "feature/app" });
          const app = yield* Prisma.App("Web", {
            project,
            branchId: branch.branchId,
            branchGitName: "feature/app",
          });
          return { project, branch, app };
        }),
      ),
    );
    expect(failure.text).toContain("branchId and branchGitName are mutually exclusive");

    yield* stack.destroy();
  }),
  { tags: [...tags, "provider:prisma:app"], timeout: 180_000 },
);

test.provider(
  "refuses to take over a branch created out of band before the deploy",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const { project } = yield* stack.deploy(projectOnly);
    const main = yield* observeDefaultBranch(project.projectId);
    const foreign = (yield* createProjectBranch({
      projectId: project.projectId,
      gitName: "feature/preview",
    })).data;

    const refused = yield* failureOf(stack.deploy(branchStack({ isDefault: true })));
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);
    // The foreign branch was neither claimed nor promoted.
    const untouched = yield* observeBranch(foreign.id);
    expect(untouched.gitName).toBe("feature/preview");
    expect(untouched.isDefault).toBe(false);
    expect((yield* observeBranch(main.id)).isDefault).toBe(true);

    // Project deletion removes the foreign branch with it.
    yield* stack.destroy();
    yield* expectBranchGone(foreign.id);
    yield* expectProjectGone(project.projectId);
  }),
  { tags, timeout: 180_000 },
);
