import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as automation from "@distilled.cloud/azure/automation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  account,
  logLevel,
  subscription,
  tags,
  waitGone,
  withSharedAccount,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (fields: string[]) =>
  Effect.gen(function* () {
    const { where } = yield* account;
    const type = yield* Azure.Automation.ConnectionType("Type", {
      ...where,
      fieldDefinitions: Object.fromEntries(
        fields.map((field) => [field, { type: "System.String" }]),
      ),
    });
    return { where, type };
  });

const getType = (
  resourceGroupName: string,
  automationAccountName: string,
  connectionTypeName: string,
) =>
  Effect.gen(function* () {
    return yield* automation.GetConnectionType({
      subscriptionId: yield* subscription,
      resourceGroupName,
      automationAccountName,
      connectionTypeName,
    });
  });

// Free: seconds to provision. Connection types have no update API, so the
// lifecycle is create → replace (field change) → delete.
test.provider(
  "create, replace, and delete a connection type",
  (stack) =>
    withSharedAccount(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { where, type } = yield* stack.deploy(program(["Endpoint"]));
        const get = (name: string) =>
          getType(where.resourceGroup, where.automationAccount, name);
        expect(type.fieldNames).toEqual(["Endpoint"]);
        const observed = yield* get(type.connectionTypeName);
        expect(Object.keys(observed.properties?.fieldDefinitions ?? {})).toEqual(
          ["Endpoint"],
        );

        // No-op redeploy keeps the type.
        const same = yield* stack.deploy(program(["Endpoint"]));
        expect(same.type.connectionTypeId).toEqual(type.connectionTypeId);

        // Replacement: field definitions are immutable.
        const replaced = yield* stack.deploy(program(["Endpoint", "Region"]));
        expect(replaced.type.connectionTypeName).not.toEqual(
          type.connectionTypeName,
        );
        expect(replaced.type.fieldNames).toEqual(["Endpoint", "Region"]);
        expect(yield* waitGone(get(type.connectionTypeName))).toEqual("gone");

        yield* stack.destroy();
        expect(yield* waitGone(get(replaced.type.connectionTypeName))).toEqual(
          "gone",
        );
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
