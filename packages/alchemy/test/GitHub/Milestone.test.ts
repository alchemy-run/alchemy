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
  "create and update milestone",
  Effect.gen(function* () {
    const stack = yield* deploy(
      yield* Test.Stack(
        "MilestoneTestStack",
        Effect.gen(function* () {
          const milestone = yield* GitHub.Milestone("test-milestone", {
            owner: testRepoOwner,
            repository: testRepoName,
            title: `Test Milestone ${Date.now()}`,
            description: "Test milestone created by Alchemy",
            dueOn: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          })
          return {
            milestoneNumber: milestone.milestoneNumber,
            title: milestone.title,
            state: milestone.state,
          }
        }),
      ),
    )

    expect(stack.milestoneNumber).toBeGreaterThan(0)
    expect(stack.title).toBeDefined()
    expect(stack.state).toBe("open")

    // Update the milestone
    const updated = yield* deploy(
      yield* Test.Stack(
        "MilestoneTestStack",
        Effect.gen(function* () {
          const milestone = yield* GitHub.Milestone("test-milestone", {
            owner: testRepoOwner,
            repository: testRepoName,
            title: stack.title.as<string>(),
            description: "Updated test milestone",
            state: "closed",
          })
          return {
            milestoneNumber: milestone.milestoneNumber,
            state: milestone.state,
          }
        }),
      ),
    )

    expect(updated.milestoneNumber).toBe(stack.milestoneNumber.as<number>())
    expect(updated.state).toBe("closed")

    yield* destroy("MilestoneTestStack")
  }).pipe(logLevel),
  { timeout: 180_000 },
)
