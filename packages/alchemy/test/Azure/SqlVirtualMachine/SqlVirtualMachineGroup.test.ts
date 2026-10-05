import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sqlvm from "@distilled.cloud/azure/sqlvirtualmachine";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { LOCATION, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getGroup = (
  resourceGroupName: string,
  sqlVirtualMachineGroupName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    sqlvm.GetSqlVirtualMachineGroup({
      subscriptionId,
      resourceGroupName,
      sqlVirtualMachineGroupName,
    }),
  );

const program = (props: {
  sqlImageSku: "Developer" | "Enterprise";
  operator?: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    // A group without member VMs is only cluster metadata: no AD domain or
    // VMs are needed until SQL VMs join it.
    const cluster = yield* Azure.SqlVirtualMachine.SqlVirtualMachineGroup(
      "Cluster",
      {
        resourceGroup: group.resourceGroupName,
        location: LOCATION,
        sqlImageOffer: "SQL2022-WS2022",
        sqlImageSku: props.sqlImageSku,
        wsfcDomainProfile: {
          domainFqdn: "alchemy-test.local",
          clusterSubnetType: "SingleSubnet",
          clusterOperatorAccount: props.operator,
        },
        tags: props.tags,
      },
    );
    return { group, cluster };
  });

// Free: a SQL VM group with no member VMs bills nothing; ~1 minute.
test.provider(
  "create, update, replace, and delete a SQL virtual machine group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster } = yield* stack.deploy(
        program({ sqlImageSku: "Developer", tags: { env: "test" } }),
      );
      expect(cluster.sqlVirtualMachineGroupName.length).toBeLessThanOrEqual(15);
      expect(cluster.sqlImageSku).toEqual("Developer");
      expect(cluster.sqlVirtualMachineGroupId).toMatch(
        /\/providers\/Microsoft\.SqlVirtualMachine\/sqlVirtualMachineGroups\//i,
      );
      const observed = yield* getGroup(
        group.resourceGroupName,
        cluster.sqlVirtualMachineGroupName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.wsfcDomainProfile?.domainFqdn).toEqual(
        "alchemy-test.local",
      );
      expect(
        observed.properties?.wsfcDomainProfile?.clusterOperatorAccount,
      ).toBeUndefined();
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Cluster");

      // In place: domain profile and tags.
      const updated = yield* stack.deploy(
        program({
          sqlImageSku: "Developer",
          operator: "operator@alchemy-test.local",
          tags: { env: "prod" },
        }),
      );
      expect(updated.cluster.sqlVirtualMachineGroupId).toEqual(
        cluster.sqlVirtualMachineGroupId,
      );
      expect(updated.cluster.tags).toEqual({ env: "prod" });
      const reobserved = yield* getGroup(
        group.resourceGroupName,
        cluster.sqlVirtualMachineGroupName,
      );
      expect(
        reobserved.properties?.wsfcDomainProfile?.clusterOperatorAccount,
      ).toEqual("operator@alchemy-test.local");
      expect(reobserved.tags?.env).toEqual("prod");

      // The SQL edition is fixed at creation: replacement.
      const replaced = yield* stack.deploy(
        program({
          sqlImageSku: "Enterprise",
          operator: "operator@alchemy-test.local",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.cluster.sqlVirtualMachineGroupName).not.toEqual(
        cluster.sqlVirtualMachineGroupName,
      );
      const replacedObserved = yield* getGroup(
        group.resourceGroupName,
        replaced.cluster.sqlVirtualMachineGroupName,
      );
      expect(replacedObserved.properties?.sqlImageSku).toEqual("Enterprise");
      expect(
        yield* waitGone(
          getGroup(group.resourceGroupName, cluster.sqlVirtualMachineGroupName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getGroup(
            group.resourceGroupName,
            replaced.cluster.sqlVirtualMachineGroupName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
