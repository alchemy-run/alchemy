import * as Azure from "@alchemy.run/azure";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import {
  fixtureAwsAccountA,
  fixtureAwsAccountB,
  getConnector,
  logLevel,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  accountId: string;
  excludedAccounts?: string[];
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location: "eastus" });
    const connector = yield* Azure.HybridConnectivity.PublicCloudConnector("Aws", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      hostType: "AWS",
      awsCloudProfile: {
        accountId: props.accountId,
        isOrganizationalAccount: true,
        excludedAccounts: props.excludedAccounts,
      },
      tags: props.tags,
    });
    return { group, connector };
  });

// Free control-plane resource; no AWS access needed. Under a minute.
test.provider(
  "create, update, replace, and delete a public cloud connector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, connector } = yield* stack.deploy(
        program({ accountId: fixtureAwsAccountA, tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(connector.publicCloudConnectorName).toMatch(/^[a-zA-Z0-9-]{3,63}$/);
      expect(connector.hostType).toEqual("AWS");
      expect(connector.tags).toEqual({ env: "test" });
      expect(connector.connectorPrimaryIdentifier).toMatch(/^[0-9a-f-]{36}$/);
      const observed = yield* getConnector(rg, connector.publicCloudConnectorName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.awsCloudProfile?.accountId).toEqual(fixtureAwsAccountA);
      expect(observed.properties?.awsCloudProfile?.isOrganizationalAccount).toEqual(true);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Aws");

      // In place: excluded accounts and tags (PATCH).
      const updated = yield* stack.deploy(
        program({
          accountId: fixtureAwsAccountA,
          excludedAccounts: ["210987654321"],
          tags: { env: "prod" },
        }),
      );
      expect(updated.connector.publicCloudConnectorId).toEqual(connector.publicCloudConnectorId);
      const reobserved = yield* getConnector(rg, connector.publicCloudConnectorName);
      expect(reobserved.properties?.awsCloudProfile?.excludedAccounts).toEqual(["210987654321"]);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the AWS account is create-only.
      const replaced = yield* stack.deploy(
        program({
          accountId: fixtureAwsAccountB,
          excludedAccounts: ["210987654321"],
          tags: { env: "prod" },
        }),
      );
      expect(replaced.connector.publicCloudConnectorName).not.toEqual(
        connector.publicCloudConnectorName,
      );
      const moved = yield* getConnector(rg, replaced.connector.publicCloudConnectorName);
      expect(moved.properties?.awsCloudProfile?.accountId).toEqual(fixtureAwsAccountB);
      const oldGone = yield* waitGone(getConnector(rg, connector.publicCloudConnectorName));
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();
      const newGone = yield* waitGone(
        getConnector(rg, replaced.connector.publicCloudConnectorName),
      );
      expect(newGone).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Free control-plane resource; no Google Cloud access needed. Under a minute.
test.provider(
  "create and delete a GCP public cloud connector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, connector } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", { location: "eastus" });
          const connector = yield* Azure.HybridConnectivity.PublicCloudConnector("Gcp", {
            resourceGroup: group.resourceGroupName,
            location: "eastus",
            hostType: "GCP",
            gcpCloudProfile: {
              projectProperties: { projectNumber: "123456789012", projectId: "alchemy-test" },
            },
          });
          return { group, connector };
        }),
      );
      const rg = group.resourceGroupName;
      expect(connector.hostType).toEqual("GCP");
      const observed = yield* getConnector(rg, connector.publicCloudConnectorName);
      expect(observed.properties?.gcpCloudProfile?.projectProperties?.projectId).toEqual(
        "alchemy-test",
      );

      yield* stack.destroy();
      const gone = yield* waitGone(getConnector(rg, connector.publicCloudConnectorName));
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
