import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as nc from "@distilled.cloud/azure/networkcloud";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  bogusCustomLocation,
  customLocationId,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const get = (resourceGroupName: string, volumeName: string) =>
  Effect.gen(function* () {
    return yield* nc.GetVolume({
      subscriptionId: yield* subscription,
      resourceGroupName,
      volumeName,
    });
  });

const program = (props: { sizeMiB: number; env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const res = yield* Azure.NetworkCloud.Volume("Volume", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      customLocationId,
      sizeMiB: props.sizeMiB,
      tags: { env: props.env },
    });
    return { group, res };
  });

// Needs a deployed Operator Nexus cluster on certified on-premises racks
// (AZURE_NEXUS_CUSTOM_LOCATION_ID); the trial cannot create one. Billed as
// part of the Nexus cluster; a few minutes once the cluster exists.
test.provider.skipIf(!runPaidOnly || !customLocationId)(
  "create, update, replace, and delete a Nexus volume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(
        program({ sizeMiB: 1024, env: "a" }),
      );
      const observed = yield* get(group.resourceGroupName, res.volumeName);
      expect(observed.properties.sizeMiB).toEqual(1024);
      expect(observed.tags?.env).toEqual("a");

      // In place (tags).
      const updated = yield* stack.deploy(program({ sizeMiB: 1024, env: "b" }));
      expect(updated.res.volumeId).toEqual(res.volumeId);
      const reobserved = yield* get(group.resourceGroupName, res.volumeName);
      expect(reobserved.tags?.env).toEqual("b");

      // Replacement (size is immutable).
      const replaced = yield* stack.deploy(
        program({ sizeMiB: 2048, env: "b" }),
      );
      expect(replaced.res.volumeName).not.toEqual(res.volumeName);
      expect(
        yield* waitGone(get(group.resourceGroupName, res.volumeName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(get(group.resourceGroupName, replaced.res.volumeName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: the trial has no Operator Nexus cluster, so the RP rejects
// a PUT against a custom location that does not exist. Only a resource group
// is created ($0, ~1-2 minutes).
test.provider(
  "the trial rejects a Nexus volume without a cluster custom location",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      const resourceGroupName = group.resourceGroupName;
      const error = yield* nc
        .VolumesCreateOrUpdate({
          subscriptionId,
          resourceGroupName,
          volumeName: "probe",
          location: "eastus",
          extendedLocation: bogusCustomLocation(
            subscriptionId,
            resourceGroupName,
          ),
          properties: { sizeMiB: 1024 },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");
      expect(error.message).toContain("custom location was not found");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
