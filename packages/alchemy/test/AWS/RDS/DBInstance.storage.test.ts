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

for (const [desired, actual, expected] of [
  [20, 30, undefined],
  [30, 30, undefined],
  [40, 30, "40"],
  [40, undefined, "40"],
] as const) {
  it.effect(
    `allocated storage ${desired} with live allocation ${actual}`,
    () =>
      withInstance(
        ({ action }) =>
          action === "DescribeDBInstances"
            ? describeInstance(instance({ AllocatedStorage: actual }))
            : response(action, ""),
        (provider, requests) =>
          Effect.gen(function* () {
            yield* reconcile(provider, { ...props, allocatedStorage: desired });
            const modifies = requests.filter(
              ({ action }) => action === "ModifyDBInstance",
            );
            expect(
              modifies.map(({ parameters }) =>
                parameters.get("AllocatedStorage"),
              ),
            ).toEqual(expected === undefined ? [] : [expected]);
          }),
      ),
    { timeout: 5000 },
  );
}
