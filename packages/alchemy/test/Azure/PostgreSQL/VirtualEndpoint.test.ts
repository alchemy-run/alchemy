import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as postgresql from "@distilled.cloud/azure/postgresql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  logLevel,
  POSTGRES_TEST_LOCATION,
  serverRef,
  tags,
  testServer,
  untilGone,
} from "./server.ts";

const { test } = Test.make({ providers: Azure.providers() });

const GENERAL_PURPOSE = {
  name: "Standard_D2ds_v5",
  tier: "GeneralPurpose",
} as const;

const program = Effect.gen(function* () {
  const { group, server } = yield* testServer({ sku: GENERAL_PURPOSE });
  const replica = yield* Azure.PostgreSQL.FlexibleServer("Replica", {
    resourceGroup: group.resourceGroupName,
    location: POSTGRES_TEST_LOCATION,
    createMode: "Replica",
    sourceServerResourceId: server.serverId,
    sku: GENERAL_PURPOSE,
  });
  const endpoint = yield* Azure.PostgreSQL.VirtualEndpoint("Endpoints", {
    resourceGroup: group.resourceGroupName,
    server: server.serverName,
    members: [replica.serverName],
  });
  return { group, server, replica, endpoint };
});

const getEndpoint = (
  resourceGroupName: string,
  serverName: string,
  virtualEndpointName: string,
) =>
  Effect.gen(function* () {
    const ref = yield* serverRef(resourceGroupName, serverName);
    return yield* postgresql.GetVirtualEndpoint({
      ...ref,
      virtualEndpointName,
    });
  });

// Needs a General Purpose primary plus a read replica: 2 × Standard_D2ds_v5
// (4 vCores, the whole trial quota) ≈ $0.36/h, ~25-30 minutes end to end.
test.provider.skipIf(!runExpensive)(
  "create and delete virtual endpoints over a read replica",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, server, replica, endpoint } = yield* stack.deploy(program);
      expect(endpoint.endpointType).toEqual("ReadWrite");
      expect(endpoint.members.map((m) => m.toLowerCase())).toContain(
        replica.serverName.toLowerCase(),
      );
      expect(endpoint.virtualEndpoints.length).toBeGreaterThan(0);
      const observed = yield* getEndpoint(
        group.resourceGroupName,
        server.serverName,
        endpoint.virtualEndpointName,
      );
      expect(observed.properties?.endpointType).toEqual("ReadWrite");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getEndpoint(
            group.resourceGroupName,
            server.serverName,
            endpoint.virtualEndpointName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);
