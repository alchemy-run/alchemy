import * as GitHub from "@/GitHub";
import { Octokit } from "@/GitHub/Octokit.ts";
import * as Provider from "@/Provider";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
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

test.provider.skipIf(!owner)(
  "list enumerates the deployed repository",
  (stack) =>
    Effect.gen(function* () {
      const name = "alchemy-effect-repo-list-test";

      // Clean up any leftovers from a previous run before deploying.
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Repository("ListRepo", {
            owner,
            name,
            description: "alchemy-effect list integration test",
            visibility: "private",
            autoInit: true,
          }).pipe(destroy());
        }),
      );

      expect(deployed.repoId).toBeGreaterThan(0);

      const provider = yield* Provider.findProvider(GitHub.Repository);
      const all = yield* provider.list();

      // The deployed repository must appear in the exhaustively-paginated result.
      expect(all.some((r) => r.repoId === deployed.repoId)).toBe(true);
      const found = all.find((r) => r.repoId === deployed.repoId);
      expect(found?.fullName).toEqual(`${owner}/${name}`);

      yield* stack.destroy();
      const afterDestroy = yield* getRepo(name);
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Read-only enumeration: `list()` needs no owner — it walks every repository the
// authenticated token can see. Gated on a non-interactive token so CI never
// stalls on the auth-method prompt; exercises the live, exhaustively-paginated
// list path without creating a repo.
const hasToken = !!(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN);
test.provider.skipIf(!hasToken)(
  "list returns the authenticated user's repositories",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(GitHub.Repository);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const repo of all) {
        expect(typeof repo.repoId).toBe("number");
        expect(typeof repo.fullName).toBe("string");
        expect(repo.fullName).toContain("/");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
