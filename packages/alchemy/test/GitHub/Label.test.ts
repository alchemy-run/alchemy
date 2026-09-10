import * as Alchemy from "@/index.ts";
import * as GitHub from "@/GitHub/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: GitHub.providers(),
});

test.provider(
  "create and update label",
  Effect.gen(function* () {
    const testId = `label-test-${Date.now()}`;
    const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-test";
    const repoName = `test-label-${testId}`;

    // Create a test repository with label
    const stack1 = yield* Alchemy.Stack(
      "LabelTest1",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const label = yield* GitHub.Label("bug", {
          owner,
          repository: repo.name!,
          name: "bug",
          color: "d73a4a",
          description: "Something isn't working",
        });

        return { repo, label };
      }),
    );

    const result1 = yield* stack1.deploy();
    expect(result1.label.name).toBe("bug");
    expect(result1.label.color).toBe("d73a4a");
    expect(result1.label.description).toBe("Something isn't working");

    // Update the label
    const stack2 = yield* Alchemy.Stack(
      "LabelTest2",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const label = yield* GitHub.Label("bug", {
          owner,
          repository: repo.name!,
          name: "bug",
          color: "ff0000",
          description: "Updated: Critical bug",
        });

        return { repo, label };
      }),
    );

    const result2 = yield* stack2.deploy();
    expect(result2.label.name).toBe("bug");
    expect(result2.label.color).toBe("ff0000");
    expect(result2.label.description).toBe("Updated: Critical bug");
    expect(result2.label.labelId).toBe(result1.label.labelId);

    // Cleanup
    yield* stack2.destroy();
  }),
  { timeout: 180_000 },
);

test.provider(
  "create multiple labels",
  Effect.gen(function* () {
    const testId = `label-multi-${Date.now()}`;
    const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-test";
    const repoName = `test-label-${testId}`;

    const stack = yield* Alchemy.Stack(
      "LabelMultiTest",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const labels = {
          bug: yield* GitHub.Label("bug", {
            owner,
            repository: repo.name!,
            name: "bug",
            color: "d73a4a",
            description: "Something isn't working",
          }),
          feature: yield* GitHub.Label("feature", {
            owner,
            repository: repo.name!,
            name: "feature",
            color: "a2eeef",
            description: "New feature or request",
          }),
          documentation: yield* GitHub.Label("docs", {
            owner,
            repository: repo.name!,
            name: "documentation",
            color: "0075ca",
            description: "Improvements to documentation",
          }),
        };

        return { repo, labels };
      }),
    );

    const result = yield* stack.deploy();
    expect(result.labels.bug.name).toBe("bug");
    expect(result.labels.feature.name).toBe("feature");
    expect(result.labels.documentation.name).toBe("documentation");

    yield* stack.destroy();
  }),
  { timeout: 180_000 },
);

test.provider(
  "replace label when name changes",
  Effect.gen(function* () {
    const testId = `label-replace-${Date.now()}`;
    const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-test";
    const repoName = `test-label-${testId}`;

    // Create label with original name
    const stack1 = yield* Alchemy.Stack(
      "LabelReplace1",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const label = yield* GitHub.Label("work", {
          owner,
          repository: repo.name!,
          name: "wip",
          color: "fbca04",
        });

        return { repo, label };
      }),
    );

    const result1 = yield* stack1.deploy();
    expect(result1.label.name).toBe("wip");
    const originalId = result1.label.labelId;

    // Change name (should replace)
    const stack2 = yield* Alchemy.Stack(
      "LabelReplace2",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const label = yield* GitHub.Label("work", {
          owner,
          repository: repo.name!,
          name: "in-progress",
          color: "fbca04",
        });

        return { repo, label };
      }),
    );

    const result2 = yield* stack2.deploy();
    expect(result2.label.name).toBe("in-progress");
    expect(result2.label.labelId).not.toBe(originalId);

    yield* stack2.destroy();
  }),
  { timeout: 180_000 },
);

test.provider(
  "list enumeration includes deployed label",
  Effect.gen(function* () {
    const testId = `label-list-${Date.now()}`;
    const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-test";
    const repoName = `test-label-${testId}`;

    const stack = yield* Alchemy.Stack(
      "LabelListTest",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const label = yield* GitHub.Label("test", {
          owner,
          repository: repo.name!,
          name: `test-${testId}`,
          color: "ededed",
          description: "For list test",
        });

        return { repo, label };
      }),
    );

    const result = yield* stack.deploy();

    // List all labels and verify ours is included
    const allLabels = yield* GitHub.Label.list();
    const found = allLabels.find((l) => l.labelId === result.label.labelId);

    expect(found).toBeDefined();
    expect(found?.name).toBe(result.label.name);

    yield* stack.destroy();
  }),
  { timeout: 180_000 },
);

test.provider(
  "label with default color",
  Effect.gen(function* () {
    const testId = `label-default-${Date.now()}`;
    const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-test";
    const repoName = `test-label-${testId}`;

    const stack = yield* Alchemy.Stack(
      "LabelDefaultTest",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const label = yield* GitHub.Label("custom", {
          owner,
          repository: repo.name!,
          name: "custom-label",
          // color omitted, should use default
          description: "Uses default color",
        });

        return { repo, label };
      }),
    );

    const result = yield* stack.deploy();
    expect(result.label.name).toBe("custom-label");
    expect(result.label.color).toBeDefined();

    yield* stack.destroy();
  }),
  { timeout: 180_000 },
);
