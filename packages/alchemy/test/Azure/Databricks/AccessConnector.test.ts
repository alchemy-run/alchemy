import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as databricks from "@distilled.cloud/azure/databricks";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnector = (resourceGroupName: string, connectorName: string) =>
  Effect.gen(function* () {
    return yield* databricks.GetAccessConnector({
      subscriptionId: yield* subscription,
      resourceGroupName,
      connectorName,
    });
  });

const program = (props: {
  name?: string;
  withUserIdentity: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "Identity",
      { resourceGroup: group.resourceGroupName },
    );
    const connector = yield* Azure.Databricks.AccessConnector("Connector", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      identity: props.withUserIdentity
        ? {
            type: "SystemAssigned,UserAssigned",
            userAssignedIdentityIds: [identity.identityId],
          }
        : { type: "SystemAssigned" },
      tags: props.tags,
    });
    return { group, identity, connector };
  });

// Access connectors are free and provision in seconds.
test.provider(
  "create, update, replace, and delete an access connector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, connector } = yield* stack.deploy(
        program({ withUserIdentity: false, tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(connector.identityType).toEqual("SystemAssigned");
      expect(connector.principalId).toBeTruthy();
      const observed = yield* getConnector(rg, connector.accessConnectorName);
      expect(observed.identity?.type).toEqual("SystemAssigned");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Connector");

      // In place: attach a user-assigned identity and change tags.
      const updated = yield* stack.deploy(
        program({ withUserIdentity: true, tags: { env: "prod" } }),
      );
      expect(updated.connector.accessConnectorId).toEqual(
        connector.accessConnectorId,
      );
      expect(updated.connector.principalId).toEqual(connector.principalId);
      const reobserved = yield* getConnector(rg, connector.accessConnectorName);
      expect(reobserved.identity?.type?.replaceAll(" ", "")).toEqual(
        "SystemAssigned,UserAssigned",
      );
      expect(
        Object.keys(reobserved.identity?.userAssignedIdentities ?? {}).map(
          (k) => k.toLowerCase(),
        ),
      ).toEqual([updated.identity.identityId.toLowerCase()]);
      expect(reobserved.tags?.env).toEqual("prod");

      // In place: detach the user-assigned identity again.
      yield* stack.deploy(
        program({ withUserIdentity: false, tags: { env: "prod" } }),
      );
      const detached = yield* getConnector(rg, connector.accessConnectorName);
      expect(detached.identity?.type).toEqual("SystemAssigned");
      expect(
        Object.keys(detached.identity?.userAssignedIdentities ?? {}),
      ).toEqual([]);

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({
          name: "connector-replaced",
          withUserIdentity: false,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.connector.accessConnectorName).not.toEqual(
        connector.accessConnectorName,
      );
      const replacedObserved = yield* getConnector(
        rg,
        replaced.connector.accessConnectorName,
      );
      expect(replacedObserved.id).toEqual(replaced.connector.accessConnectorId);
      expect(
        yield* waitGone(getConnector(rg, connector.accessConnectorName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getConnector(rg, replaced.connector.accessConnectorName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
