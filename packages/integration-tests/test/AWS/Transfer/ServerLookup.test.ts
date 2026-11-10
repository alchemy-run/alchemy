import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails } from "../../lookup.ts";

const { test } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:transfer", "live"];

test.provider(
  "a lookup of a missing server fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const lookups = {
        "missing-server": AWS.Transfer.Server.lookup({ serverId: "s-00000000000000000" }).serverId,
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
