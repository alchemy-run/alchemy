import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as batch from "@distilled.cloud/aws/batch";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "probe live batch state",
  () =>
    Effect.gen(function* () {
      const queues = yield* batch.describeJobQueues({
        jobQueues: ["alchemy-test-batch-jq"],
      });
      yield* Effect.log(`queues: ${JSON.stringify(queues.jobQueues, null, 2)}`);
      const ces = yield* batch.describeComputeEnvironments({
        computeEnvironments: ["alchemy-test-batch-jq-ce"],
      });
      yield* Effect.log(
        `ces: ${JSON.stringify(
          ces.computeEnvironments?.map((ce) => ({
            name: ce.computeEnvironmentName,
            status: ce.status,
            state: ce.state,
          })),
          null,
          2,
        )}`,
      );
    }),
  { timeout: 60_000 },
);
