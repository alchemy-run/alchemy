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

for (const desired of [5432, 5433]) {
  it.effect(
    `compares port ${desired} to the endpoint rather than DbInstancePort`,
    () => {
      let currentPort = 5432;
      return withInstance(
        ({ action, parameters }) => {
          if (action === "DescribeDBInstances") {
            return describeInstance(
              instance({ Endpoint: { Port: currentPort }, DbInstancePort: 0 }),
            );
          }
          if (action === "ModifyDBInstance")
            currentPort = Number(parameters.get("DBPortNumber"));
          return response(action, "");
        },
        (provider, requests) =>
          Effect.gen(function* () {
            const result = yield* reconcile(provider, {
              ...props,
              port: desired,
            });
            expect(result.endpointPort).toBe(desired);
            expect(
              requests
                .filter(({ action }) => action === "ModifyDBInstance")
                .map(({ parameters }) => parameters.get("DBPortNumber")),
            ).toEqual(desired === 5432 ? [] : ["5433"]);
          }),
      );
    },
    { timeout: 5000 },
  );
}
