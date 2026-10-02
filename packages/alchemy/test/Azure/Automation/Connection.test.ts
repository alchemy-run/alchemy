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
  sharedAccountTest,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name?: string;
  endpoint: string;
  description?: string;
}) =>
  Effect.gen(function* () {
    const { where } = yield* account;
    const type = yield* Azure.Automation.ConnectionType("Type", {
      ...where,
      fieldDefinitions: { Endpoint: { type: "System.String" } },
    });
    const connection = yield* Azure.Automation.Connection("Connection", {
      ...where,
      name: props.name,
      connectionType: type.connectionTypeName,
      fieldDefinitionValues: { Endpoint: props.endpoint },
      description: props.description,
    });
    return { where, type, connection };
  });

const getConnection = (
  resourceGroupName: string,
  automationAccountName: string,
  connectionName: string,
) =>
  Effect.gen(function* () {
    return yield* automation.GetConnection({
      subscriptionId: yield* subscription,
      resourceGroupName,
      automationAccountName,
      connectionName,
    });
  });

// Free: seconds to provision.
test.provider(
  "create, update, replace, and delete a connection",
  (stack) =>
    sharedAccountTest(stack)(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { where, type, connection } = yield* stack.deploy(
          program({ endpoint: "https://a.example.com" }),
        );
        const get = (name: string) =>
          getConnection(where.resourceGroup, where.automationAccount, name);
        expect(connection.connectionType).toEqual(type.connectionTypeName);
        const observed = yield* get(connection.connectionName);
        expect(observed.properties?.fieldDefinitionValues?.Endpoint).toEqual(
          "https://a.example.com",
        );

        // In-place: field value and description.
        const updated = yield* stack.deploy(
          program({ endpoint: "https://b.example.com", description: "b" }),
        );
        expect(updated.connection.connectionId).toEqual(
          connection.connectionId,
        );
        const reobserved = yield* get(connection.connectionName);
        expect(reobserved.properties?.fieldDefinitionValues?.Endpoint).toEqual(
          "https://b.example.com",
        );
        expect(reobserved.properties?.description).toEqual("b");

        // Replacement: the name is immutable.
        const replaced = yield* stack.deploy(
          program({
            name: "alchemy-test-connection-renamed",
            endpoint: "https://b.example.com",
            description: "b",
          }),
        );
        expect(replaced.connection.connectionName).toEqual(
          "alchemy-test-connection-renamed",
        );
        expect(yield* waitGone(get(connection.connectionName))).toEqual("gone");

        yield* stack.destroy();
        expect(
          yield* waitGone(get(replaced.connection.connectionName)),
        ).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
