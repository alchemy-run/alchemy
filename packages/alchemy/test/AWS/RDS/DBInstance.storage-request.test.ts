import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  describeInstance,
  instance,
  props,
  reconcile,
  response,
  withInstance,
} from "./DBInstance.provider.ts";

for (const [name, desired, expected] of [
  [
    "IOPS changes preserve autoscaled storage over a smaller declaration",
    { iops: 4000, allocatedStorage: 20 },
    { Iops: "4000", AllocatedStorage: "50" },
  ],
  [
    "storage increase includes unchanged IOPS",
    { allocatedStorage: 60 },
    { AllocatedStorage: "60", Iops: "3000" },
  ],
  [
    "throughput includes unchanged IOPS and live allocation",
    { storageThroughput: 250 },
    { StorageThroughput: "250", Iops: "3000", AllocatedStorage: "50" },
  ],
  [
    "IOPS includes live allocation",
    { iops: 4000 },
    { Iops: "4000", AllocatedStorage: "50" },
  ],
  [
    "combined changes retain desired storage increase",
    { iops: 4000, allocatedStorage: 60 },
    { Iops: "4000", AllocatedStorage: "60" },
  ],
] as const) {
  it.effect(
    name,
    () =>
      withInstance(
        ({ action }) =>
          action === "DescribeDBInstances"
            ? describeInstance(
                instance({
                  StorageType: "gp3",
                  StorageThroughput: 125,
                  Iops: 3000,
                  AllocatedStorage: 50,
                }),
              )
            : response(action, ""),
        (provider, requests) =>
          Effect.gen(function* () {
            yield* reconcile(provider, { ...props, ...desired });
            const modifies = requests.filter(
              ({ action }) => action === "ModifyDBInstance",
            );
            expect(modifies).toHaveLength(1);
            for (const [key, value] of Object.entries(expected)) {
              expect(modifies[0]!.parameters.get(key)).toBe(value);
            }
          }),
      ),
    { timeout: 5000 },
  );
}

it.effect(
  "unchanged gp3 storage sends no modification",
  () =>
    withInstance(
      ({ action }) =>
        action === "DescribeDBInstances"
          ? describeInstance(
              instance({
                StorageType: "gp3",
                StorageThroughput: 125,
                Iops: 3000,
                AllocatedStorage: 50,
              }),
            )
          : response(action, ""),
      (provider, requests) =>
        Effect.gen(function* () {
          yield* reconcile(provider, {
            ...props,
            storageType: "gp3",
            storageThroughput: 125,
            iops: 3000,
            allocatedStorage: 50,
          });
          expect(
            requests.filter(({ action }) => action === "ModifyDBInstance"),
          ).toEqual([]);
        }),
    ),
  { timeout: 5000 },
);
