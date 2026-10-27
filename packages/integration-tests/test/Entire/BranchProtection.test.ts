import * as Entire from "@alchemy.run/entire";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as EntireSdk from "@distilled.cloud/entire";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Entire.providers() });

// Entire caps an account's projects and org creations, and a burst of
// parallel creates leaves projects whose owner grant never lands, so the
// Entire suites take turns.
const opts = { tags: ["provider:entire", "live"], timeout: 180_000, exclusive: "entire:account" };

const app = (rules: Entire.BranchProtectionRule[]) =>
  Effect.gen(function* () {
    const project = yield* Entire.Project("Project", {});
    const repo = yield* Entire.Repo("Repo", { projectId: project.id });
    yield* Entire.BranchProtection("Protection", { repoId: repo.id, rules });
    return repo;
  });

test.provider(
  "set, change and clear rules",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repo = yield* stack.deploy(app([{ ref: "HEAD", serverSideMergeOnly: true }]));
      expect((yield* EntireSdk.repos.getBranchProtection({ repoId: repo.id })).rules).toEqual([
        { ref: "HEAD", serverSideMergeOnly: true },
      ]);

      yield* stack.deploy(
        app([{ ref: "HEAD" }, { ref: "refs/heads/release/*", serverSideMergeOnly: true }]),
      );
      expect((yield* EntireSdk.repos.getBranchProtection({ repoId: repo.id })).rules).toEqual([
        { ref: "HEAD", serverSideMergeOnly: false },
        { ref: "refs/heads/release/*", serverSideMergeOnly: true },
      ]);

      // Removing the resource clears the repository's rules.
      yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Entire.Project("Project", {});
          return yield* Entire.Repo("Repo", { projectId: project.id });
        }),
      );
      expect((yield* EntireSdk.repos.getBranchProtection({ repoId: repo.id })).rules).toEqual([]);

      yield* stack.destroy();
    }),
  opts,
);
