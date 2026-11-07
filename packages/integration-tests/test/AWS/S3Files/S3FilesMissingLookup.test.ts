import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:s3files", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (access point, file system).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-access-point": AWS.S3Files.AccessPoint.lookup({
          accessPointId: "fsap-0123456789abcdef0",
        }).accessPointId,
        "missing-file-system": AWS.S3Files.FileSystem.lookup({
          fileSystemId: "fs-0123456789abcdef0",
        }).fileSystemId,
      });
    }),
  { tags, timeout: 180_000 },
);
