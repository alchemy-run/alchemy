import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:fsx", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (file system).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* expectAllMissing(stack, {
        "missing-fsx": AWS.FSx.FileSystem.lookup({ fileSystemId: "fs-00000000000000000" })
          .fileSystemArn,
      });
    }),
  { tags, timeout: 180_000 },
);
