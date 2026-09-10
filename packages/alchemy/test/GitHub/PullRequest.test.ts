import * as GitHub from "@/GitHub"
import * as Test from "@/Test/Alchemy"
import { expect } from "alchemy-test"
import * as Effect from "effect/Effect"
import { MinimumLogLevel } from "effect/References"

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: GitHub.providers(),
})

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
)

const testRepoOwner = process.env.GITHUB_TEST_OWNER || "agustif"
const testRepoName = process.env.GITHUB_TEST_REPO || "alchemy"

test.skip(
  "create and update pull request",
  Effect.gen(function* () {
    const stack = yield* deploy(
      yield* Test.Stack(
        "PullRequestTestStack",
        Effect.gen(function* () {
          const pr = yield* GitHub.PullRequest("test-pr", {
            owner: testRepoOwner,
            repository: testRepoName,
            title: "Test PR from Alchemy",
            body: "This is a test pull request created by Alchemy.",
            head: "test-branch",
            base: "main",
            draft: true,
            labels: ["test", "alchemy"],
          })
          return { prNumber: pr.prNumber, htmlUrl: pr.htmlUrl, draft: pr.draft }
        }),
      ),
    )

    expect(stack.prNumber).toBeGreaterThan(0)
    expect(stack.htmlUrl).toContain("github.com")
    expect(stack.draft).toBe(true)

    // Update the PR
    const updated = yield* deploy(
      yield* Test.Stack(
        "PullRequestTestStack",
        Effect.gen(function* () {
          const pr = yield* GitHub.PullRequest("test-pr", {
            owner: testRepoOwner,
            repository: testRepoName,
            title: "Updated Test PR from Alchemy",
            body: "This PR has been updated.",
            head: "test-branch",
            base: "main",
            draft: false,
            labels: ["test", "alchemy", "updated"],
          })
          return { prNumber: pr.prNumber, draft: pr.draft }
        }),
      ),
    )

    expect(updated.prNumber).toBe(stack.prNumber)
    expect(updated.draft).toBe(false)

    yield* destroy("PullRequestTestStack")
  }).pipe(logLevel),
  { timeout: 180_000 },
)
