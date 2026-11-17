import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as efs from "@distilled.cloud/aws/efs";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { testName } from "../../names.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:efs", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "EfsLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const files = yield* AWS.EFS.FileSystem("lookup-target", {
      tags: { Name: testName("alchemy-lookup") },
    });
    const ap = yield* AWS.EFS.AccessPoint("lookup-target-ap", { fileSystemId: files.fileSystemId });
    return {
      fileSystemId: files.fileSystemId.as<string>(),
      fileSystemArn: files.fileSystemArn.as<string>(),
      accessPointId: ap.accessPointId.as<string>(),
      accessPointArn: ap.accessPointArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "file systems resolve by id and Name tag, access points by id, and both survive destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { fileSystemId, fileSystemArn, accessPointId, accessPointArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return {
            byName: AWS.EFS.FileSystem.lookup({ name: testName("alchemy-lookup") }).fileSystemId,
            byId: AWS.EFS.FileSystem.lookup({ fileSystemId }).fileSystemArn,
            ap: AWS.EFS.AccessPoint.lookup({ accessPointId }).accessPointArn,
          };
        },
        {
          byName: fileSystemId,
          byId: fileSystemArn,
          ap: accessPointArn,
        },
      );
      const { FileSystems } = yield* efs.describeFileSystems({ FileSystemId: fileSystemId });
      expect(FileSystems?.[0]?.FileSystemId).toBe(fileSystemId);
    }),
  { tags, timeout: 300_000 },
);

test.provider(
  "a lookup of a missing file system or access point fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-file-system": AWS.EFS.FileSystem.lookup({ name }).fileSystemId,
        "missing-access-point": AWS.EFS.AccessPoint.lookup({
          accessPointId: "fsap-00000000000000000",
        }).accessPointArn,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(stack.deploy(AWS.SSM.Parameter(id, { value })), [
          "LookupNotFoundError",
        ]);
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 300_000 },
);

test.provider(
  "a lookup of a file system this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.EFS.FileSystem("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-file-system-consumer", {
              value: AWS.EFS.FileSystem.lookup({ fileSystemId: attrs.fileSystemId }).fileSystemArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 300_000 },
);
