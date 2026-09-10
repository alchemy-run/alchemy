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

const getCollaborators = (repo: string) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit
    return yield* Effect.tryPromise({
      try: async () => {
        try {
          const collaborators = await octokit.paginate(
            octokit.rest.repos.listCollaborators,
            {
              owner,
              repo,
              per_page: 100,
            },
          )
          return collaborators
        } catch (error: any) {
          if (error.status === 404) return []
          throw error
        }
      },
      catch: (e) => e as Error,
    })
  })

test.provider.skipIf(!owner || !canDeleteRepos)(
  "add and remove a collaborator",
  (stack) =>
    Effect.gen(function* () {
      const repoName = "alchemy-collaborator-test"
      const testUser = process.env.GITHUB_TEST_COLLABORATOR_USERNAME

      if (!testUser) {
        console.log(
          "Skipping: Set GITHUB_TEST_COLLABORATOR_USERNAME to run this test",
        )
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

      // Add collaborator with push permission
      const collab = yield* stack.deploy(
        Effect.gen(function* () {
          yield* GitHub.Repository("TestRepo", {
            owner,
            name: repoName,
            visibility: "private",
            autoInit: true,
          }).pipe(destroy())

          return yield* GitHub.Collaborator("Collab", {
            owner,
            repository: repoName,
            username: testUser,
            permission: "push",
          }).pipe(destroy())
        }),
      )

      expect(collab.username).toEqual(testUser)
      expect(collab.permission).toEqual("push")

      // Verify collaborator was added via GitHub API
      const collaborators = yield* getCollaborators(repoName)
      const addedCollab = collaborators.find((c: any) => c.login === testUser)
      expect(addedCollab).toBeDefined()
      expect(addedCollab?.permissions?.push).toEqual(true)

      // Update permission to admin
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          yield* GitHub.Repository("TestRepo", {
            owner,
            name: repoName,
            visibility: "private",
            autoInit: true,
          }).pipe(destroy())

          return yield* GitHub.Collaborator("Collab", {
            owner,
            repository: repoName,
            username: testUser,
            permission: "admin",
          }).pipe(destroy())
        }),
      )

      expect(updated.permission).toEqual("admin")

      const updatedCollaborators = yield* getCollaborators(repoName)
      const updatedCollab = updatedCollaborators.find(
        (c: any) => c.login === testUser,
      )
      expect(updatedCollab?.permissions?.admin).toEqual(true)

      // Clean up
      yield* stack.destroy()

      const finalCollaborators = yield* getCollaborators(repoName)
      const removedCollab = finalCollaborators.find(
        (c: any) => c.login === testUser,
      )
      expect(removedCollab).toBeUndefined()
    }).pipe(logLevel),
)

test(
  "list collaborators across repositories",
  Effect.gen(function* () {
    const listed = yield* Effect.gen(function* () {
      return yield* Effect.serviceOption(GitHub.Collaborator).pipe(
        Effect.flatMap(Effect.liftOption),
        Effect.flatMap((provider) => provider.list()),
      )
    })

    // The list operation succeeds and returns an array
    expect(Array.isArray(listed)).toBe(true)
  }).pipe(logLevel),
)
