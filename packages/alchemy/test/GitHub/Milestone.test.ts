import * as Alchemy from "@/index.ts";
import * as GitHub from "@/GitHub/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: GitHub.providers(),
});

test.provider(
  "create and update milestone",
  Effect.gen(function* () {
    const testId = `milestone-test-${Date.now()}`;
    const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-test";
    const repoName = `test-milestone-${testId}`;

    // Create a test repository with milestone
    const stack1 = yield* Alchemy.Stack(
      "MilestoneTest1",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const milestone = yield* GitHub.Milestone("v1", {
          owner,
          repository: repo.name!,
          title: "v1.0.0",
          description: "First release",
        });

        return { repo, milestone };
      }),
    );

    const result1 = yield* stack1.deploy();
    expect(result1.milestone.title).toBe("v1.0.0");
    expect(result1.milestone.state).toBe("open");
    expect(result1.milestone.description).toBe("First release");

    // Update the milestone
    const stack2 = yield* Alchemy.Stack(
      "MilestoneTest2",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const milestone = yield* GitHub.Milestone("v1", {
          owner,
          repository: repo.name!,
          title: "v1.0.0",
          description: "Updated: Bug fixes and improvements",
          dueOn: "2027-12-31",
        });

        return { repo, milestone };
      }),
    );

    const result2 = yield* stack2.deploy();
    expect(result2.milestone.title).toBe("v1.0.0");
    expect(result2.milestone.description).toBe(
      "Updated: Bug fixes and improvements",
    );
    expect(result2.milestone.dueOn).toBe("2027-12-31T00:00:00Z");
    expect(result2.milestone.milestoneNumber).toBe(
      result1.milestone.milestoneNumber,
    );

    // Cleanup
    yield* stack2.destroy();
  }),
  { timeout: 180_000 },
);

test.provider(
  "close and reopen milestone",
  Effect.gen(function* () {
    const testId = `milestone-state-${Date.now()}`;
    const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-test";
    const repoName = `test-milestone-${testId}`;

    // Create open milestone
    const stack1 = yield* Alchemy.Stack(
      "MilestoneStateTest1",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const milestone = yield* GitHub.Milestone("release", {
          owner,
          repository: repo.name!,
          title: "Release v2.0",
          state: "open",
        });

        return { repo, milestone };
      }),
    );

    const result1 = yield* stack1.deploy();
    expect(result1.milestone.state).toBe("open");
    expect(result1.milestone.closedAt).toBe(null);

    // Close the milestone
    const stack2 = yield* Alchemy.Stack(
      "MilestoneStateTest2",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const milestone = yield* GitHub.Milestone("release", {
          owner,
          repository: repo.name!,
          title: "Release v2.0",
          state: "closed",
        });

        return { repo, milestone };
      }),
    );

    const result2 = yield* stack2.deploy();
    expect(result2.milestone.state).toBe("closed");
    expect(result2.milestone.closedAt).not.toBe(null);

    // Reopen the milestone
    const stack3 = yield* Alchemy.Stack(
      "MilestoneStateTest3",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const milestone = yield* GitHub.Milestone("release", {
          owner,
          repository: repo.name!,
          title: "Release v2.0",
          state: "open",
        });

        return { repo, milestone };
      }),
    );

    const result3 = yield* stack3.deploy();
    expect(result3.milestone.state).toBe("open");

    yield* stack3.destroy();
  }),
  { timeout: 180_000 },
);

test.provider(
  "replace milestone when title changes",
  Effect.gen(function* () {
    const testId = `milestone-replace-${Date.now()}`;
    const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-test";
    const repoName = `test-milestone-${testId}`;

    // Create milestone with original title
    const stack1 = yield* Alchemy.Stack(
      "MilestoneReplace1",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const milestone = yield* GitHub.Milestone("q1", {
          owner,
          repository: repo.name!,
          title: "Q1 2026",
          description: "First quarter goals",
        });

        return { repo, milestone };
      }),
    );

    const result1 = yield* stack1.deploy();
    expect(result1.milestone.title).toBe("Q1 2026");
    const originalNumber = result1.milestone.milestoneNumber;

    // Change title (should replace)
    const stack2 = yield* Alchemy.Stack(
      "MilestoneReplace2",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const milestone = yield* GitHub.Milestone("q1", {
          owner,
          repository: repo.name!,
          title: "Q1 2027",
          description: "Updated quarter goals",
        });

        return { repo, milestone };
      }),
    );

    const result2 = yield* stack2.deploy();
    expect(result2.milestone.title).toBe("Q1 2027");
    expect(result2.milestone.milestoneNumber).not.toBe(originalNumber);

    yield* stack2.destroy();
  }),
  { timeout: 180_000 },
);

test.provider(
  "list enumeration includes deployed milestone",
  Effect.gen(function* () {
    const testId = `milestone-list-${Date.now()}`;
    const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-test";
    const repoName = `test-milestone-${testId}`;

    const stack = yield* Alchemy.Stack(
      "MilestoneListTest",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const milestone = yield* GitHub.Milestone("test", {
          owner,
          repository: repo.name!,
          title: `Test Milestone ${testId}`,
          description: "For list test",
        });

        return { repo, milestone };
      }),
    );

    const result = yield* stack.deploy();

    // List all milestones and verify ours is included
    const allMilestones = yield* GitHub.Milestone.list();
    const found = allMilestones.find(
      (m) => m.milestoneNumber === result.milestone.milestoneNumber,
    );

    expect(found).toBeDefined();
    expect(found?.title).toBe(result.milestone.title);

    yield* stack.destroy();
  }),
  { timeout: 180_000 },
);

test.provider(
  "milestone with due date",
  Effect.gen(function* () {
    const testId = `milestone-duedate-${Date.now()}`;
    const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-test";
    const repoName = `test-milestone-${testId}`;

    const stack = yield* Alchemy.Stack(
      "MilestoneDueDateTest",
      { providers: GitHub.providers() },
      Effect.gen(function* () {
        const repo = yield* GitHub.Repository(testId, {
          owner,
          name: repoName,
          autoInit: true,
        }).pipe(Alchemy.destroy());

        const milestone = yield* GitHub.Milestone("sprint", {
          owner,
          repository: repo.name!,
          title: "Sprint 1",
          description: "Complete authentication",
          dueOn: "2026-12-31",
        });

        return { repo, milestone };
      }),
    );

    const result = yield* stack.deploy();
    expect(result.milestone.title).toBe("Sprint 1");
    expect(result.milestone.dueOn).toBe("2026-12-31T00:00:00Z");

    yield* stack.destroy();
  }),
  { timeout: 180_000 },
);
