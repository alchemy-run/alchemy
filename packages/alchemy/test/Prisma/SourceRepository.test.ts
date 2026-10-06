import {
  getSourceRepositories,
  getSourceRepository,
  NotFound,
} from "@distilled.cloud/prisma/management";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Prisma from "@/Prisma";
import * as Test from "@/Test/Alchemy";
import { expectGone, expectProjectGone, failureOf, forgetState } from "./fixtures/Live.ts";
import { fakeCloudProviders, makeFakeCloud } from "./fixtures/ResourcesFake.ts";

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
// refused. This pins that refusal; the link lifecycle runs against the fake
// below, and live when PRISMA_TEST_GITHUB_REPOSITORY_ID names a repository the
// workspace's installation can see.
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

const fakeTags = [
  "unit",
  "provider:prisma",
  "provider:prisma:project",
  "provider:prisma:sourcerepository",
  "local",
];

const lifecycleCloud = makeFakeCloud();
const lifecycle = Test.make({ providers: fakeCloudProviders(lifecycleCloud) });

lifecycle.test.provider(
  "links a repository, refuses a relink without touching it, and unlinks on destroy",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const linked = yield* stack.deploy(repositoryStack(123));
    expect(linked.repository.repoId).toBe(123);
    expect(linked.repository.provider).toBe("github");
    expect(linked.repository.status).toBe("active");
    expect(linked.repository.defaultBranch).toBe("main");
    const posted = lifecycleCloud.api.captured.filter(
      (request) => request.method === "POST" && request.pathname === "/v1/source-repositories",
    );
    expect(posted.map((request) => request.bodyJson)).toEqual([
      { projectId: linked.project.projectId, provider: "github", providerRepositoryId: 123 },
    ]);

    const settled = yield* stack.plan(repositoryStack(123));
    expect(settled.resources["Repository"]).toMatchObject({ action: "noop" });
    const relink = yield* failureOf(stack.plan(repositoryStack(456)));
    expect(relink.text).toContain("cannot be replaced atomically");
    expect(lifecycleCloud.repositories.get(linked.repository.sourceRepositoryId)?.status).toBe(
      "active",
    );

    yield* stack.destroy();
    expect(
      lifecycleCloud.api.captured.some(
        (request) =>
          request.method === "DELETE" &&
          request.pathname === `/v1/source-repositories/${linked.repository.sourceRepositoryId}`,
      ),
    ).toBe(true);
  }),
  { tags: fakeTags },
);

const adoptionCloud = makeFakeCloud();
const adoption = Test.make({ providers: fakeCloudProviders(adoptionCloud) });

adoption.test.provider(
  "requires adoption for an existing link after lost state and treats an unlinked one as gone",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const linked = yield* stack.deploy(repositoryStack(123));
    yield* forgetState(stack, "Repository");
    const refused = yield* failureOf(stack.deploy(repositoryStack(123)));
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);

    const adopted = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const repository = yield* Prisma.SourceRepository("Repository", {
          project,
          providerRepositoryId: 123,
        }).pipe(adopt(true));
        return { project, repository };
      }),
    );
    expect(adopted.repository.sourceRepositoryId).toBe(linked.repository.sourceRepositoryId);

    // Unlinked out of band: the 404 on delete means already gone.
    adoptionCloud.repositories.get(linked.repository.sourceRepositoryId)!.status = "archived";
    yield* stack.destroy();
    expect(
      adoptionCloud.api.captured.filter(
        (request) =>
          request.method === "DELETE" && request.pathname.startsWith("/v1/source-repositories/"),
      ),
    ).toEqual([]);
  }),
  { tags: fakeTags },
);

const raceCloud = makeFakeCloud();
const race = Test.make({ providers: fakeCloudProviders(raceCloud) });

race.test.provider(
  "refuses to take over a link that appears after the adoption check",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    raceCloud.faults.race.add("sourceRepository");
    const failure = yield* failureOf(stack.deploy(repositoryStack(123)));
    expect(failure.text).toContain("appeared after the adoption check");
    expect(
      Array.from(raceCloud.repositories.values()).map((repository) => repository.status),
    ).toEqual(["active"]);

    yield* stack.destroy();
  }),
  { tags: fakeTags },
);
