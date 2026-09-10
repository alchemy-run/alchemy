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

const getRulesets = (repo: string) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit
    return yield* Effect.tryPromise({
      try: async () => {
        try {
          const rulesets = await octokit.paginate(
            octokit.rest.repos.getRepoRulesets,
            {
              owner,
              repo,
              per_page: 100,
            },
          )
          return rulesets
        } catch (error: any) {
          if (error.status === 404) return []
          throw error
        }
      },
      catch: (e) => e as Error,
    })
  })

test.provider.skipIf(!owner || !canDeleteRepos)(
  "create, update, and delete a ruleset",
  (stack) =>
    Effect.gen(function* () {
      const repoName = "alchemy-ruleset-test"

      yield* stack.destroy()

      // Create a test repository first
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Repository("TestRepo", {
            owner,
            name: repoName,
            visibility: "private",
            autoInit: true,
          }).pipe(destroy())
        }),
      )

      // Create ruleset
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          yield* GitHub.Repository("TestRepo", {
            owner,
            name: repoName,
            visibility: "private",
            autoInit: true,
          }).pipe(destroy())

          return yield* GitHub.Ruleset("MainProtection", {
            owner,
            repository: repoName,
            name: "main protection",
            target: "branch",
            enforcement: "active",
            conditions: {
              include: ["refs/heads/main"],
            },
            rules: {
              nonFastForward: true,
              deletion: true,
            },
          }).pipe(destroy())
        }),
      )

      expect(created.rulesetId).toBeGreaterThan(0)
      expect(created.name).toEqual("main protection")

      // Verify ruleset via GitHub API
      const rulesets = yield* getRulesets(repoName)
      const found = rulesets.find((r: any) => r.id === created.rulesetId)
      expect(found).toBeDefined()
      expect(found?.name).toEqual("main protection")

      // Update ruleset
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          yield* GitHub.Repository("TestRepo", {
            owner,
            name: repoName,
            visibility: "private",
            autoInit: true,
          }).pipe(destroy())

          return yield* GitHub.Ruleset("MainProtection", {
            owner,
            repository: repoName,
            name: "updated main protection",
            target: "branch",
            enforcement: "active",
            conditions: {
              include: ["refs/heads/main", "refs/heads/release/*"],
            },
            rules: {
              nonFastForward: true,
              deletion: true,
              requiredLinearHistory: true,
            },
          }).pipe(destroy())
        }),
      )

      expect(updated.rulesetId).toEqual(created.rulesetId)
      expect(updated.name).toEqual("updated main protection")

      // Verify update
      const updatedRulesets = yield* getRulesets(repoName)
      const updatedFound = updatedRulesets.find(
        (r: any) => r.id === created.rulesetId,
      )
      expect(updatedFound?.name).toEqual("updated main protection")

      // Clean up
      yield* stack.destroy()

      const finalRulesets = yield* getRulesets(repoName)
      const deleted = finalRulesets.find((r: any) => r.id === created.rulesetId)
      expect(deleted).toBeUndefined()
    }).pipe(logLevel),
)

test(
  "list rulesets across repositories",
  Effect.gen(function* () {
    const listed = yield* Effect.gen(function* () {
      return yield* Effect.serviceOption(GitHub.Ruleset).pipe(
        Effect.flatMap(Effect.liftOption),
        Effect.flatMap((provider) => provider.list()),
      )
    })

    // The list operation succeeds and returns an array
    expect(Array.isArray(listed)).toBe(true)
  }).pipe(logLevel),
)
