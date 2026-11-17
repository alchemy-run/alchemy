import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";

const { test } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:mq", "live"];

test.provider(
  "a lookup of a missing broker or configuration fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-broker": AWS.MQ.Broker.lookup({ brokerName: name }).brokerArn,
        "missing-configuration": AWS.MQ.Configuration.lookup({ configurationName: name })
          .configurationArn,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(stack.deploy(AWS.SSM.Parameter(id, { value })), [
          "LookupNotFoundError",
        ]);
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
