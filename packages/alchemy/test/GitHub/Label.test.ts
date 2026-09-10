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
  "create and update label",
  Effect.gen(function* () {
    const stack = yield* deploy(
      yield* Test.Stack(
        "LabelTestStack",
        Effect.gen(function* () {
          const label = yield* GitHub.Label("test-label", {
            owner: testRepoOwner,
            repository: testRepoName,
            name: `test-${Date.now()}`,
            color: "ff0000",
            description: "Test label created by Alchemy",
          })
          return { name: label.name, color: label.color }
        }),
      ),
    )

    expect(stack.name).toBeDefined()
    expect(stack.color).toBe("ff0000")

    // Update the label
    const updated = yield* deploy(
      yield* Test.Stack(
        "LabelTestStack",
        Effect.gen(function* () {
          const label = yield* GitHub.Label("test-label", {
            owner: testRepoOwner,
            repository: testRepoName,
            name: stack.name.as<string>(),
            color: "00ff00",
            description: "Updated test label",
          })
          return { name: label.name, color: label.color }
        }),
      ),
    )

    expect(updated.name).toBe(stack.name.as<string>())
    expect(updated.color).toBe("00ff00")

    yield* destroy("LabelTestStack")
  }).pipe(logLevel),
  { timeout: 180_000 },
)
