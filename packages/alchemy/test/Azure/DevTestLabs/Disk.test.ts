import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  labUserFixture,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDisk = (
  resourceGroupName: string,
  labName: string,
  userName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetDisk({
      subscriptionId: yield* subscription,
      resourceGroupName,
      labName,
      userName,
      name,
    });
  });

const program = (props: { sizeGiB: number; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const { group, lab, user } = yield* labUserFixture();
    const disk = yield* Azure.DevTestLabs.Disk("Data", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      user: user.userName,
      diskType: "Standard",
      diskSizeGiB: props.sizeGiB,
      tags: props.tags,
    });
    return { group, lab, user, disk };
  });

// Free lab + a 4 GiB standard disk (~$0.0003/hour); ~8 minutes.
test.provider(
  "create, update, replace, and delete a lab disk",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lab, user, disk } = yield* stack.deploy(
        program({ sizeGiB: 4, tags: { env: "test" } }),
      );
      const get = (name: string) =>
        getDisk(group.resourceGroupName, lab.labName, user.userName, name);
      const observed = yield* get(disk.diskName);
      expect(observed.properties?.diskSizeGiB).toEqual(4);
      expect(observed.properties?.diskType).toEqual("Standard");
      expect(disk.managedDiskId).toBeDefined();

      // In-place: tags.
      const updated = yield* stack.deploy(
        program({ sizeGiB: 4, tags: { env: "prod" } }),
      );
      expect(updated.disk.diskId).toEqual(disk.diskId);
      expect((yield* get(disk.diskName)).tags?.env).toEqual("prod");

      // Replacement: size.
      const replaced = yield* stack.deploy(
        program({ sizeGiB: 8, tags: { env: "prod" } }),
      );
      expect(replaced.disk.diskName).not.toEqual(disk.diskName);
      expect(
        (yield* get(replaced.disk.diskName)).properties?.diskSizeGiB,
      ).toEqual(8);
      expect(yield* waitGone(get(disk.diskName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.disk.diskName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
