import * as Entire from "@alchemy.run/entire";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as EntireSdk from "@distilled.cloud/entire";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Entire.providers() });

// Entire caps an account's projects and org creations, and a burst of
// parallel creates leaves projects whose owner grant never lands, so the
// Entire suites take turns.
const opts = {
  tags: ["provider:entire", "live"],
  timeout: 180_000,
  exclusive: "entire:account",
};

const app = (repo: Omit<Entire.RepoProps, "projectId">) =>
  Effect.gen(function* () {
    const project = yield* Entire.Project("Project", {});
    return yield* Entire.Repo("Repo", { projectId: project.id, ...repo });
  });

const rulesOf = (repoId: string) =>
  EntireSdk.repos.getBranchProtection({ repoId }).pipe(Effect.map((r) => r.rules));

const secretKeysOf = (repoId: string) =>
  EntireSdk.repoSettings
    .listRepoSecrets({ repo_id: repoId })
    .pipe(Effect.map((r) => (r.items ?? []).map((i) => i.secretKey).sort()));

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

test.provider(
  "branch protection: set, change, unmanaged, clear",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repo = yield* stack.deploy(
        app({ branchProtection: [{ ref: "HEAD", serverSideMergeOnly: true }] }),
      );
      expect(yield* rulesOf(repo.id)).toEqual([{ ref: "HEAD", serverSideMergeOnly: true }]);

      yield* stack.deploy(
        app({
          branchProtection: [
            { ref: "HEAD" },
            { ref: "refs/heads/release/*", serverSideMergeOnly: true },
          ],
        }),
      );
      const changed = [
        { ref: "HEAD", serverSideMergeOnly: false },
        { ref: "refs/heads/release/*", serverSideMergeOnly: true },
      ];
      expect(yield* rulesOf(repo.id)).toEqual(changed);

      // Leaving the prop out keeps the rules and reports them.
      const unmanaged = yield* stack.deploy(app({}));
      expect(unmanaged.branchProtection).toEqual(changed);
      expect(yield* rulesOf(repo.id)).toEqual(changed);

      // `[]` clears them.
      yield* stack.deploy(app({ branchProtection: [] }));
      expect(yield* rulesOf(repo.id)).toEqual([]);

      yield* stack.destroy();
    }),
  opts,
);

test.provider(
  "settings: write declared, keep undeclared",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        app({ trailsEnabled: false, runnersEnabled: true, autoRunOnPush: true }),
      );
      expect(first).toMatchObject({
        trailsEnabled: false,
        runnersEnabled: true,
        autoRunOnPush: true,
      });

      const second = yield* stack.deploy(app({ trailsEnabled: true, publicSharingEnabled: true }));
      expect(second).toMatchObject({
        trailsEnabled: true,
        runnersEnabled: true,
        autoRunOnPush: true,
        publicSharingEnabled: true,
      });
      // Out of band: the cell reports the stored settings, and the runner
      // settings (not declared in the second deploy) kept their values.
      const meta = yield* EntireSdk.repoDetails.getRepoMeta({ repo_id: second.id });
      expect(meta).toMatchObject({
        trails_enabled: true,
        runners_enabled: true,
        auto_run_on_push: true,
        public_sharing_enabled: true,
      });

      yield* stack.destroy();
    }),
  opts,
);

test.provider(
  "secrets: set, rotate, add, remove",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repo = yield* stack.deploy(
        app({ secrets: { api_key_anthropic: Redacted.make("sk-ant-test-1") } }),
      );
      expect(repo.secretKeys).toEqual(["api_key_anthropic"]);
      expect(yield* secretKeysOf(repo.id)).toEqual(["api_key_anthropic"]);

      // A new value is written in place, and a second key is added.
      const both = yield* stack.deploy(
        app({
          secrets: {
            api_key_anthropic: Redacted.make("sk-ant-test-2"),
            api_key_openai: Redacted.make("sk-openai-test-1"),
          },
        }),
      );
      expect(both.id).toEqual(repo.id);
      expect(yield* secretKeysOf(repo.id)).toEqual(["api_key_anthropic", "api_key_openai"]);

      // A key left out of `secrets` is removed.
      yield* stack.deploy(app({ secrets: { api_key_openai: Redacted.make("sk-openai-test-1") } }));
      expect(yield* secretKeysOf(repo.id)).toEqual(["api_key_openai"]);

      yield* stack.destroy();
    }),
  opts,
);
