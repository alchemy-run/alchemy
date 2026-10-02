import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cs from "@distilled.cloud/azure/containerservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { withPublicIps, withVcpus } from "../gates.ts";
import { logLevel, tags, testCluster, untilGone } from "./cluster.ts";

const { test } = Test.make({ providers: Azure.providers() });

const location = "northcentralus";

const getMember = (
  resourceGroupName: string,
  fleetName: string,
  fleetMemberName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* cs.GetFleetMember({
      subscriptionId,
      resourceGroupName,
      fleetName,
      fleetMemberName,
    });
  });

const program = (group: string) =>
  Effect.gen(function* () {
    const { group: rg, cluster } = yield* testCluster(location);
    const fleet = yield* Azure.ContainerService.Fleet("Fleet", {
      resourceGroup: rg.resourceGroupName,
      location,
    });
    const member = yield* Azure.ContainerService.FleetMember("Member", {
      resourceGroup: rg.resourceGroupName,
      fleet: fleet.fleetName,
      clusterResourceId: cluster.clusterId,
      group,
      labels: { tier: group },
    });
    return { group: rg, cluster, fleet, member };
  });

// Test cluster (~6 min create, ~5 min delete, ~$0.03), a free hubless
// fleet, and the membership (~2-4 min to join).
test.provider(
  "join, update, and remove a fleet member",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program("staging"));
      const { group, fleet, member, cluster } = created;
      expect(member.group).toEqual("staging");
      expect(member.clusterResourceId.toLowerCase()).toEqual(
        cluster.clusterId.toLowerCase(),
      );
      const observed = yield* getMember(
        group.resourceGroupName,
        fleet.fleetName,
        member.memberName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.labels?.tier).toEqual("staging");

      const updated = yield* stack.deploy(program("production"));
      expect(updated.member.memberName).toEqual(member.memberName);
      expect(updated.member.group).toEqual("production");
      const reobserved = yield* getMember(
        group.resourceGroupName,
        fleet.fleetName,
        member.memberName,
      );
      expect(reobserved.properties?.group).toEqual("production");
      expect(reobserved.properties?.labels?.tier).toEqual("production");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getMember(
            group.resourceGroupName,
            fleet.fleetName,
            member.memberName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withPublicIps(1), withVcpus(2), logLevel),
  { tags: [...tags], timeout: 900_000 },
);
