import * as Alchemy from "@/index.ts";
import * as GitHub from "@/GitHub/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({
  providers: GitHub.providers(),
});

test.provider(
  "create and update release",
  Effect.gen(function* () {
    const testId = `release-test-${Date.now()}`;
    const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-test";
    const repoName = `test-release-${testId}`;

    // Create a test repository with release
    const stack1 = yield* Alchemy.Stack(
      "ReleaseTest1",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const release = yield* GitHub.Release("v1", {
          owner,
          repository: repo.name!,
          tagName: "v1.0.0",
          name: "Version 1.0.0",
          body: "First release",
        });

        return { repo, release };
      }),
    );

    const result1 = yield* stack1.deploy();
    expect(result1.release.tagName).toBe("v1.0.0");
    expect(result1.release.name).toBe("Version 1.0.0");
    expect(result1.release.body).toBe("First release");
    expect(result1.release.draft).toBe(false);
    expect(result1.release.prerelease).toBe(false);

    // Update the release
    const stack2 = yield* Alchemy.Stack(
      "ReleaseTest2",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const release = yield* GitHub.Release("v1", {
          owner,
          repository: repo.name!,
          tagName: "v1.0.0",
          name: "Version 1.0.0",
          body: "Updated: Bug fixes and improvements",
        });

        return { repo, release };
      }),
    );

    const result2 = yield* stack2.deploy();
    expect(result2.release.tagName).toBe("v1.0.0");
    expect(result2.release.body).toBe("Updated: Bug fixes and improvements");
    expect(result2.release.releaseId).toBe(result1.release.releaseId);

    yield* stack2.destroy();
  }),
  { timeout: 180_000 },
);

test.provider(
  "create draft and publish",
  Effect.gen(function* () {
    const testId = `release-draft-${Date.now()}`;
    const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-test";
    const repoName = `test-release-${testId}`;

    // Create draft release
    const stack1 = yield* Alchemy.Stack(
      "ReleaseDraft1",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const release = yield* GitHub.Release("v2", {
          owner,
          repository: repo.name!,
          tagName: "v2.0.0",
          name: "Version 2.0.0",
          body: "Draft release notes",
          draft: true,
        });

        return { repo, release };
      }),
    );

    const result1 = yield* stack1.deploy();
    expect(result1.release.draft).toBe(true);
    expect(result1.release.publishedAt).toBe(null);

    // Publish the release
    const stack2 = yield* Alchemy.Stack(
      "ReleaseDraft2",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const release = yield* GitHub.Release("v2", {
          owner,
          repository: repo.name!,
          tagName: "v2.0.0",
          name: "Version 2.0.0",
          body: "Published release notes",
          draft: false,
        });

        return { repo, release };
      }),
    );

    const result2 = yield* stack2.deploy();
    expect(result2.release.draft).toBe(false);
    expect(result2.release.publishedAt).not.toBe(null);

    yield* stack2.destroy();
  }),
  { timeout: 180_000 },
);

test.provider(
  "create prerelease",
  Effect.gen(function* () {
    const testId = `release-pre-${Date.now()}`;
    const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-test";
    const repoName = `test-release-${testId}`;

    const stack = yield* Alchemy.Stack(
      "ReleasePrereleaseTest",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const release = yield* GitHub.Release("beta", {
          owner,
          repository: repo.name!,
          tagName: "v3.0.0-beta.1",
          name: "v3.0.0 Beta 1",
          body: "Beta release for testing",
          prerelease: true,
        });

        return { repo, release };
      }),
    );

    const result = yield* stack.deploy();
    expect(result.release.tagName).toBe("v3.0.0-beta.1");
    expect(result.release.prerelease).toBe(true);
    expect(result.release.draft).toBe(false);

    yield* stack.destroy();
  }),
  { timeout: 180_000 },
);

test.provider(
  "list enumeration includes deployed release",
  Effect.gen(function* () {
    const testId = `release-list-${Date.now()}`;
    const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-test";
    const repoName = `test-release-${testId}`;

    const stack = yield* Alchemy.Stack(
      "ReleaseListTest",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const release = yield* GitHub.Release("test", {
          owner,
          repository: repo.name!,
          tagName: `test-${testId}`,
          name: "Test Release",
          body: "For list test",
        });

        return { repo, release };
      }),
    );

    const result = yield* stack.deploy();

    // List all releases and verify ours is included
    const allReleases = yield* GitHub.Release.list();
    const found = allReleases.find(
      (r) => r.releaseId === result.release.releaseId,
    );

    expect(found).toBeDefined();
    expect(found?.tagName).toBe(result.release.tagName);

    yield* stack.destroy();
  }),
  { timeout: 180_000 },
);
