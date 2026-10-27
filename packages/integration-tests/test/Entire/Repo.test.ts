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

const app = (repo: Omit<Entire.RepoProps, "projectId">) =>
  Effect.gen(function* () {
    const project = yield* Entire.Project("Project", {});
    return yield* Entire.Repo("Repo", { projectId: project.id, ...repo });
  });

test.provider(
  "create, update visibility, replace on rename, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repo = yield* stack.deploy(app({}));
      expect(repo.visibility).toEqual("private");
      expect(repo.apiUrl).toBeDefined();
      const observed = yield* EntireSdk.repos.getRepo({ repoId: repo.id });
      expect(observed.state).toEqual("active");
      expect(observed.name).toEqual(repo.name);

      // Visibility changes in place.
      const pub = yield* stack.deploy(app({ visibility: "public" }));
      expect(pub.id).toEqual(repo.id);
      const visibility = yield* EntireSdk.repos.getRepoVisibility({ repoId: repo.id });
      expect(visibility.visibility).toEqual("public");

      // A new name is a new repository.
      const renamed = yield* stack.deploy(app({ visibility: "public", name: "renamed" }));
      expect(renamed.id).not.toEqual(repo.id);
      expect(renamed.name).toEqual("renamed");
      const oldGone = yield* EntireSdk.repos.getRepo({ repoId: repo.id }).pipe(Effect.flip);
      expect(oldGone._tag).toEqual("NotFound");

      yield* stack.destroy();
      const gone = yield* EntireSdk.repos.getRepo({ repoId: renamed.id }).pipe(Effect.flip);
      expect(gone._tag).toEqual("NotFound");
    }),
  opts,
);
