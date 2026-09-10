import * as GitHub from "@/GitHub"
import { Octokit } from "@/GitHub/Octokit.ts"
import { destroy } from "@/RemovalPolicy"
import * as Test from "@/Test/Alchemy"
import { expect } from "alchemy-test"
import * as Effect from "effect/Effect"
import { MinimumLogLevel } from "effect/References"

const { test } = Test.make({ providers: GitHub.providers() })

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
)

const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test"
const canDeleteRepos = !!process.env.GITHUB_TEST_DELETE_REPO

const getTeams = (repo: string) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit
    return yield* Effect.tryPromise({
      try: async () => {
        try {
          const teams = await octokit.paginate(octokit.rest.repos.listTeams, {
            owner,
            repo,
            per_page: 100,
          })
          return teams
        } catch (error: any) {
          if (error.status === 404) return []
          throw error
        }
      },
      catch: (e) => e as Error,
    })
  })

test.provider.skipIf(!owner || !canDeleteRepos)(
  "grant and revoke team access",
  (stack) =>
    Effect.gen(function* () {
      const repoName = "alchemy-team-access-test"
      const testTeam = process.env.GITHUB_TEST_TEAM_SLUG

      if (!testTeam) {
        console.log("Skipping: Set GITHUB_TEST_TEAM_SLUG to run this test")
        return
      }

      yield* stack.destroy()

      // Create a test repository first
      const repo = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Repository("TestRepo", {
            owner,
            name: repoName,
            visibility: "private",
            autoInit: true,
          }).pipe(destroy())
        }),
      )

      // Grant team push permission
      const teamAccess = yield* stack.deploy(
        Effect.gen(function* () {
          yield* GitHub.Repository("TestRepo", {
            owner,
            name: repoName,
            visibility: "private",
            autoInit: true,
          }).pipe(destroy())

          return yield* GitHub.TeamAccess("TeamAccess", {
            owner,
            repository: repoName,
            teamSlug: testTeam,
            permission: "push",
          }).pipe(destroy())
        }),
      )

      expect(teamAccess.teamSlug).toEqual(testTeam)
      expect(teamAccess.permission).toEqual("push")

      // Verify team access via GitHub API
      const teams = yield* getTeams(repoName)
      const addedTeam = teams.find((t: any) => t.slug === testTeam)
      expect(addedTeam).toBeDefined()
      expect(addedTeam?.permission).toEqual("push")

      // Update permission to admin
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          yield* GitHub.Repository("TestRepo", {
            owner,
            name: repoName,
            visibility: "private",
            autoInit: true,
          }).pipe(destroy())

          return yield* GitHub.TeamAccess("TeamAccess", {
            owner,
            repository: repoName,
            teamSlug: testTeam,
            permission: "admin",
          }).pipe(destroy())
        }),
      )

      expect(updated.permission).toEqual("admin")

      const updatedTeams = yield* getTeams(repoName)
      const updatedTeam = updatedTeams.find((t: any) => t.slug === testTeam)
      expect(updatedTeam?.permission).toEqual("admin")

      // Clean up
      yield* stack.destroy()

      const finalTeams = yield* getTeams(repoName)
      const removedTeam = finalTeams.find((t: any) => t.slug === testTeam)
      expect(removedTeam).toBeUndefined()
    }).pipe(logLevel),
)

test(
  "list team access across repositories",
  Effect.gen(function* () {
    const listed = yield* Effect.gen(function* () {
      return yield* Effect.serviceOption(GitHub.TeamAccess).pipe(
        Effect.flatMap(Effect.liftOption),
        Effect.flatMap((provider) => provider.list()),
      )
    })

    // The list operation succeeds and returns an array
    expect(Array.isArray(listed)).toBe(true)
  }).pipe(logLevel),
)
