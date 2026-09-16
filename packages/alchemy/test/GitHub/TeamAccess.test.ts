import * as Repos from "@distilled.cloud/github/repos";
import * as Teams from "@distilled.cloud/github/teams";
import * as GitHub from "@/GitHub";
import { githubFor } from "@/GitHub/Client.ts";
import * as Output from "@/Output";
import * as Provider from "@/Provider";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const testOwner = (value: string) => {
  if (value !== "alchemy-run-test" && value !== "alchemy-run-test-2") {
    throw new Error(`Unsafe GITHUB_TEST_OWNER: ${value}`);
  }
  return value;
};
const owner = testOwner(process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test");
testOwner(process.env.GITHUB_TEST_OWNER_2 ?? "alchemy-run-test-2");
const repositoryName = "alchemy-pr-1572-team-access";
const teamName = "alchemy-pr-1572-team-access";
const { test } = Test.make({
  providers: GitHub.providers({ baseUrl: "github.com" }),
});

const getTeams = (repo: string) =>
  Effect.gen(function* () {
    const github = yield* githubFor();
    return yield* Repos.listTeams
      .items({ owner, repo, per_page: 100 })
      .pipe(Stream.runCollect, github);
  });

test.provider(
  "grant, update, list, and revoke dedicated team access",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const github = yield* githubFor();
      // Creating a fresh dedicated team requires admin:org; never use an existing team's access.
      // A leftover team from an interrupted run 422s on create — converge onto it by slug.
      const team = yield* Teams.create({
        org: owner,
        name: teamName,
        privacy: "closed",
      }).pipe(
        github,
        Effect.catchTag("UnprocessableEntity", () =>
          Teams.getByName({ org: owner, team_slug: teamName }).pipe(github),
        ),
      );
      expect(team.slug).toBe(teamName);

      const deployAccess = (
        permission?: GitHub.TeamAccessProps["permission"],
      ) =>
        stack.deploy(
          Effect.gen(function* () {
            // Retained intentionally: the default gh token does not have delete_repo.
            const repo = yield* GitHub.Repository("Repo", {
              owner,
              name: repositoryName,
              visibility: "private",
              autoInit: true,
            });
            return yield* GitHub.TeamAccess("TeamAccess", {
              owner,
              repository: Output.map(
                repo.fullName,
                (fullName) => fullName.split("/")[1]!,
              ),
              teamSlug: team.slug,
              permission,
            }).pipe(destroy());
          }),
        );

      yield* Effect.gen(function* () {
        const created = yield* deployAccess();
        expect(created).toEqual({ teamSlug: team.slug, permission: "push" });
        expect(
          (yield* getTeams(repositoryName)).find(
            (item) => item.slug === team.slug,
          )?.permission,
        ).toBe("push");
        const provider = yield* Provider.findProvider(GitHub.TeamAccess);
        expect(yield* provider.list()).toContainEqual({
          teamSlug: team.slug,
          permission: "push",
        });

        const updated = yield* deployAccess("admin");
        expect(updated.permission).toBe("admin");
        expect(
          (yield* getTeams(repositoryName)).find(
            (item) => item.slug === team.slug,
          )?.permission,
        ).toBe("admin");
      }).pipe(
        Effect.onExit(() =>
          Effect.gen(function* () {
            yield* stack.destroy();
            // Verify access removal while both the repository and team still exist.
            expect(
              (yield* getTeams(repositoryName)).find(
                (item) => item.slug === team.slug,
              ),
            ).toBeUndefined();
            yield* Teams.deleteInOrg({ org: owner, team_slug: team.slug }).pipe(
              github,
            );
            const remaining = yield* Teams.list
              .items({ org: owner, per_page: 100 })
              .pipe(Stream.runCollect, github);
            expect(remaining.some((item) => item.slug === team.slug)).toBe(
              false,
            );
          }).pipe(Effect.orDie),
        ),
      );
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates team access for the authenticated token",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const provider = yield* Provider.findProvider(GitHub.TeamAccess);
      expect(Array.isArray(yield* provider.list())).toBe(true);
      yield* stack.destroy();
    }),
);

test(
  "unit: rejects production and arbitrary fixture owners",
  Effect.sync(() => {
    expect(() => testOwner("alchemy-run")).toThrow("Unsafe GITHUB_TEST_OWNER");
    expect(() => testOwner("personal-account")).toThrow(
      "Unsafe GITHUB_TEST_OWNER",
    );
    expect(() => testOwner("")).toThrow("Unsafe GITHUB_TEST_OWNER");
    expect(testOwner("alchemy-run-test")).toBe("alchemy-run-test");
    expect(testOwner("alchemy-run-test-2")).toBe("alchemy-run-test-2");
  }),
);
