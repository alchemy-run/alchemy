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

test(
  "create and update issue",
  Effect.gen(function* () {
    const stack = yield* deploy(
      yield* Test.Stack(
        "IssueTestStack",
        Effect.gen(function* () {
          const issue = yield* GitHub.Issue("test-issue", {
            owner: testRepoOwner,
            repository: testRepoName,
            title: "Test Issue from Alchemy",
            body: "This is a test issue created by Alchemy.",
            labels: ["test", "alchemy"],
          })
          return { issueNumber: issue.issueNumber, htmlUrl: issue.htmlUrl }
        }),
      ),
    )

    expect(stack.issueNumber).toBeGreaterThan(0)
    expect(stack.htmlUrl).toContain("github.com")

    // Update the issue
    const updated = yield* deploy(
      yield* Test.Stack(
        "IssueTestStack",
        Effect.gen(function* () {
          const issue = yield* GitHub.Issue("test-issue", {
            owner: testRepoOwner,
            repository: testRepoName,
            title: "Updated Test Issue from Alchemy",
            body: "This issue has been updated.",
            labels: ["test", "alchemy", "updated"],
            state: "closed",
          })
          return { issueNumber: issue.issueNumber, state: issue.state }
        }),
      ),
    )

    expect(updated.issueNumber).toBe(stack.issueNumber)
    expect(updated.state).toBe("closed")

    yield* destroy("IssueTestStack")
  }).pipe(logLevel),
  { timeout: 180_000 },
)
