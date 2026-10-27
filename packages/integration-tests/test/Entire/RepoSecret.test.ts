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

import * as Redacted from "effect/Redacted";

const repoCell = (repoId: string) =>
  Effect.gen(function* () {
    const repo = yield* EntireSdk.repos.getRepo({ repoId });
    return repo.placements?.find((p) => p.id === repo.id)?.apiBaseUrl;
  });

const secretKeys = (repoId: string) =>
  EntireSdk.repoSettings
    .listRepoSecrets({ repo_id: repoId })
    .pipe(Effect.map((r) => (r.items ?? []).map((i) => i.secretKey)));

test.provider(
  "set, rotate and delete a key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = (value: string) =>
        Effect.gen(function* () {
          const project = yield* Entire.Project("Project", {});
          const repo = yield* Entire.Repo("Repo", { projectId: project.id });
          yield* Entire.RepoSecret("Anthropic", {
            repoId: repo.id,
            key: "api_key_anthropic",
            value: Redacted.make(value),
          });
          return repo;
        });

      const repo = yield* stack.deploy(app("sk-ant-test-1"));
      expect(yield* repoCell(repo.id)).toEqual(repo.apiUrl);
      expect(yield* secretKeys(repo.id)).toEqual(["api_key_anthropic"]);

      // A new value is written in place.
      yield* stack.deploy(app("sk-ant-test-2"));
      expect(yield* secretKeys(repo.id)).toEqual(["api_key_anthropic"]);

      yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Entire.Project("Project", {});
          return yield* Entire.Repo("Repo", { projectId: project.id });
        }),
      );
      expect(yield* secretKeys(repo.id)).toEqual([]);

      yield* stack.destroy();
    }),
  opts,
);
