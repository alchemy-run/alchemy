import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import {
  flexApp,
  flexConnectionString,
  flexStorage,
} from "./fixtures/flex-app.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getIdentifier = (
  resourceGroupName: string,
  name: string,
  domainOwnershipIdentifierName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetWebAppDomainOwnershipIdentifier({
      subscriptionId,
      resourceGroupName,
      name,
      domainOwnershipIdentifierName,
    });
  });

const identifierGone = (
  resourceGroupName: string,
  name: string,
  identifierName: string,
) =>
  getIdentifier(resourceGroupName, name, identifierName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (
  connection: string,
  identifier: { name: string | undefined; value: string } | undefined,
) =>
  Effect.gen(function* () {
    const { group, app } = yield* flexApp(connection);
    const id =
      identifier === undefined
        ? undefined
        : yield* Azure.Web.DomainOwnershipIdentifier("Ownership", {
            resourceGroup: group.resourceGroupName,
            siteName: app.siteName,
            name: identifier.name,
            value: identifier.value,
          });
    return { group, app, id };
  });

// Cost: ~$0 (Flex Consumption, idle; Standard_LRS storage). Provisioning:
// ~2-4 minutes.
test.provider(
  "create, update, replace, and delete a domain ownership identifier",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(flexStorage);
      const connection = yield* flexConnectionString(
        group.resourceGroupName,
        account.storageAccountName,
      );

      const created = yield* stack.deploy(
        program(connection, { name: undefined, value: "value-one" }),
      );
      const id = created.id!;
      expect(id.value).toEqual("value-one");
      const observed = yield* getIdentifier(
        group.resourceGroupName,
        created.app.siteName,
        id.identifierName,
      );
      expect(observed.properties?.id).toEqual("value-one");

      // In-place update: the value.
      const updated = yield* stack.deploy(
        program(connection, { name: undefined, value: "value-two" }),
      );
      expect(updated.id!.identifierName).toEqual(id.identifierName);
      const reobserved = yield* getIdentifier(
        group.resourceGroupName,
        created.app.siteName,
        id.identifierName,
      );
      expect(reobserved.properties?.id).toEqual("value-two");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program(connection, { name: "alchemy-renamed", value: "value-two" }),
      );
      expect(replaced.id!.identifierName).toEqual("alchemy-renamed");
      expect(
        yield* identifierGone(
          group.resourceGroupName,
          created.app.siteName,
          id.identifierName,
        ),
      ).toEqual("gone");

      // Delete only the identifier.
      yield* stack.deploy(program(connection, undefined));
      expect(
        yield* identifierGone(
          group.resourceGroupName,
          created.app.siteName,
          "alchemy-renamed",
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);
