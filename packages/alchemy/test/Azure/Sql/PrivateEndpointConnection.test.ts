import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import type * as Redacted from "effect/Redacted";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { logLevel, newPassword, SQL_TAGS, sqlServer } from "./harness.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  serverName: string,
  privateEndpointConnectionName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* sql.GetPrivateEndpointConnection({
      subscriptionId,
      resourceGroupName,
      serverName,
      privateEndpointConnectionName,
    });
  });

const connectionGone = (rg: string, serverName: string, name: string) =>
  getConnection(rg, serverName, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (
  password: Redacted.Redacted<string>,
  approval?: {
    status: "Approved" | "Rejected";
    description: string;
  },
) =>
  Effect.gen(function* () {
    const { group, server } = yield* sqlServer(password);
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Endpoints", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
    });
    const endpoint = yield* Azure.Network.PrivateEndpoint("SqlPe", {
      resourceGroup: group.resourceGroupName,
      subnetId: subnet.subnetId,
      manualPrivateLinkServiceConnections: [
        {
          privateLinkServiceId: server.serverId,
          groupIds: ["sqlServer"],
          requestMessage: "please approve",
        },
      ],
    });
    const connection = approval
      ? yield* Azure.Sql.PrivateEndpointConnection("SqlPeApproval", {
          resourceGroup: group.resourceGroupName,
          server: server.serverName,
          privateEndpointId: endpoint.privateEndpointId,
          status: approval.status,
          description: approval.description,
        })
      : undefined;
    return { group, server, endpoint, connection };
  });

// Private endpoint ~$0.01/hour; the server has no hourly charge. The test
// runs for a few minutes (well under $0.01).
test.provider(
  "approve and delete a sql private endpoint connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const created = yield* stack.deploy(
        program(password, {
          status: "Approved",
          description: "approved by alchemy",
        }),
      );
      const rg = created.group.resourceGroupName;
      const serverName = created.server.serverName;
      const name = created.connection!.privateEndpointConnectionName;
      expect(created.connection!.status).toEqual("Approved");
      const observed = yield* getConnection(rg, serverName, name);
      expect(
        observed.properties?.privateLinkServiceConnectionState?.status,
      ).toEqual("Approved");
      expect(
        observed.properties?.privateLinkServiceConnectionState?.description,
      ).toEqual("approved by alchemy");
      expect(observed.properties?.privateEndpoint?.id?.toLowerCase()).toEqual(
        created.endpoint.privateEndpointId.toLowerCase(),
      );

      // Azure SQL decisions are final; a description-only change is a no-op.
      const updated = yield* stack.deploy(
        program(password, {
          status: "Approved",
          description: "still approved",
        }),
      );
      expect(updated.connection!.privateEndpointConnectionName).toEqual(name);
      expect(updated.connection!.status).toEqual("Approved");

      // Removing the resource deletes the connection.
      yield* stack.deploy(program(password));
      expect(yield* connectionGone(rg, serverName, name)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* connectionGone(rg, serverName, name)).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 900_000 },
);
