import * as GitHub from "@/GitHub";
import { Octokit } from "@/GitHub/Octokit.ts";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GitHub.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// These tests create, mutate, and delete a real repository, so they require an
// owner (user login or org) the token can write to. Skip when unset.
const owner = process.env.GITHUB_TEST_OWNER ?? "";

const getRepo = (repo: string) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit;
    return yield* Effect.tryPromise({
      try: async () => {
        try {
          const { data } = await octokit.rest.repos.get({ owner, repo });
          return data;
        } catch (error: any) {
          if (error.status === 404) return undefined;
          throw error;
        }
      },
      catch: (e) => e as Error,
    });
  });

test.provider.skipIf(!owner)(
  "create, update, rename, and delete a repository",
  (stack) =>
    Effect.gen(function* () {
      const name = "alchemy-effect-repo-test";
      const renamed = "alchemy-effect-repo-test-renamed";

      // Clean up any leftovers from a previous run before deploying.
      yield* stack.destroy();

      // Create
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Repository("Repo", {
            owner,
            name,
            description: "alchemy-effect integration test",
            visibility: "private",
            autoInit: true,
            hasWiki: false,
            topics: ["alchemy", "test"],
          }).pipe(destroy());
        }),
      );

      expect(created.repoId).toBeGreaterThan(0);
      expect(created.fullName).toEqual(`${owner}/${name}`);
      expect(created.defaultBranch).toBeDefined();

      const fetched = yield* getRepo(name);
      expect(fetched?.id).toEqual(created.repoId);
      expect(fetched?.description).toEqual("alchemy-effect integration test");
      expect(fetched?.private).toEqual(true);
      expect(fetched?.has_wiki).toEqual(false);
      expect(fetched?.topics).toEqual(
        expect.arrayContaining(["alchemy", "test"]),
      );

      // Update — change settings and topics, same logical ID → same repoId.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Repository("Repo", {
            owner,
            name,
            description: "updated description",
            visibility: "private",
            hasWiki: true,
            topics: ["alchemy"],
          }).pipe(destroy());
        }),
      );

      expect(updated.repoId).toEqual(created.repoId);
      const afterUpdate = yield* getRepo(name);
      expect(afterUpdate?.description).toEqual("updated description");
      expect(afterUpdate?.has_wiki).toEqual(true);
      expect(afterUpdate?.topics).toEqual(["alchemy"]);

      // Rename — new `name`, same logical ID → in-place rename, same repoId.
      const wasRenamed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Repository("Repo", {
            owner,
            name: renamed,
            description: "updated description",
            visibility: "private",
          }).pipe(destroy());
        }),
      );

      expect(wasRenamed.repoId).toEqual(created.repoId);
      expect(wasRenamed.fullName).toEqual(`${owner}/${renamed}`);
      const afterRename = yield* getRepo(renamed);
      expect(afterRename?.id).toEqual(created.repoId);
      const oldName = yield* getRepo(name);
      expect(oldName).toBeUndefined();

      // Delete
      yield* stack.destroy();
      const afterDestroy = yield* getRepo(renamed);
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
