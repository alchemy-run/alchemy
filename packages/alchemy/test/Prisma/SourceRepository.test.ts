import {
  getSourceRepositories,
  getSourceRepository,
  NotFound,
} from "@distilled.cloud/prisma/management";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Prisma from "@/Prisma";
import * as Test from "@/Test/Alchemy";
import { expectGone, expectProjectGone, failureOf } from "./fixtures/Live.ts";

const { test } = Test.make({ providers: Prisma.providers() });

const liveTags = [
  "provider:prisma",
  "provider:prisma:project",
  "provider:prisma:sourcerepository",
  "live",
];

const repositoryStack = (providerRepositoryId: number) =>
  Effect.gen(function* () {
    const project = yield* Prisma.Project("Project", { createDatabase: false });
    const repository = yield* Prisma.SourceRepository("Repository", {
      project,
      providerRepositoryId,
    });
    return { project, repository };
  });

// The testing workspace has no GitHub SCM installation, so a live link is
// refused. This pins that refusal; the link lifecycle runs live when
// PRISMA_TEST_GITHUB_REPOSITORY_ID names a repository the workspace's
// installation can see.
test.provider(
  "linking without a GitHub installation is refused by Prisma",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const failure = yield* failureOf(stack.deploy(repositoryStack(1)));
    expect(failure.errors.some((error) => error instanceof NotFound)).toBe(true);
    expect(failure.text).toContain("scmInstallation not found");

    const { project } = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        return { project };
      }),
    );
    expect((yield* getSourceRepositories({ projectId: project.projectId })).data).toEqual([]);

    yield* stack.destroy();
    yield* expectProjectGone(project.projectId);
  }),
  { tags: liveTags, timeout: 120_000 },
);

const githubRepositoryId = Number(process.env.PRISMA_TEST_GITHUB_REPOSITORY_ID ?? "0");

test.provider.skipIf(!githubRepositoryId)(
  "links a GitHub repository, refuses a relink, and unlinks it on destroy",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const linked = yield* stack.deploy(repositoryStack(githubRepositoryId));
    expect(linked.repository.repoId).toBe(githubRepositoryId);
    expect(linked.repository.status).toBe("active");
    expect(linked.repository.projectId).toBe(linked.project.projectId);

    const settled = yield* stack.plan(repositoryStack(githubRepositoryId));
    expect(settled.resources["Repository"]).toMatchObject({ action: "noop" });
    const relink = yield* failureOf(stack.plan(repositoryStack(githubRepositoryId + 1)));
    expect(relink.text).toContain("cannot be replaced atomically");

    yield* stack.destroy();
    yield* expectGone(
      getSourceRepository({ id: linked.repository.sourceRepositoryId }).pipe(
        Effect.map((response) => response.data.status !== "active"),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      ),
    );
    yield* expectProjectGone(linked.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);
