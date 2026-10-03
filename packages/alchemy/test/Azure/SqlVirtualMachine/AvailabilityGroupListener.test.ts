import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sqlvm from "@distilled.cloud/azure/sqlvirtualmachine";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runPaidOnly } from "../gates.ts";
import { LOCATION, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getListener = (
  resourceGroupName: string,
  sqlVirtualMachineGroupName: string,
  availabilityGroupListenerName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    sqlvm.GetAvailabilityGroupListener({
      subscriptionId,
      resourceGroupName,
      sqlVirtualMachineGroupName,
      availabilityGroupListenerName,
    }),
  );

/**
 * An Always On listener needs an Active Directory domain controller, two
 * domain-joined Windows VMs running SQL Server Enterprise/Developer, a
 * cloud witness, and an internal load balancer — more than the trial's
 * ~4 regional vCPUs and an external AD the test cannot build. The paid
 * lifecycle takes that pre-built environment from env vars.
 */
const env = (key: string) => process.env[key] ?? "";
const ag = {
  resourceGroup: env("AZURE_TEST_SQLVM_AG_RESOURCE_GROUP"),
  domainFqdn: env("AZURE_TEST_SQLVM_AG_DOMAIN"),
  bootstrapAccount: env("AZURE_TEST_SQLVM_AG_BOOTSTRAP_ACCOUNT"),
  operatorAccount: env("AZURE_TEST_SQLVM_AG_OPERATOR_ACCOUNT"),
  sqlServiceAccount: env("AZURE_TEST_SQLVM_AG_SQL_SERVICE_ACCOUNT"),
  password: env("AZURE_TEST_SQLVM_AG_PASSWORD"),
  witnessUrl: env("AZURE_TEST_SQLVM_AG_WITNESS_URL"),
  witnessKey: env("AZURE_TEST_SQLVM_AG_WITNESS_KEY"),
  vm1: env("AZURE_TEST_SQLVM_AG_VM1_ID"),
  vm2: env("AZURE_TEST_SQLVM_AG_VM2_ID"),
  loadBalancerId: env("AZURE_TEST_SQLVM_AG_LOAD_BALANCER_ID"),
  subnetId: env("AZURE_TEST_SQLVM_AG_SUBNET_ID"),
};

const paidProgram = (props: { port: number }) =>
  Effect.gen(function* () {
    const cluster = yield* Azure.SqlVirtualMachine.SqlVirtualMachineGroup(
      "Cluster",
      {
        resourceGroup: ag.resourceGroup,
        location: LOCATION,
        sqlImageOffer: "SQL2022-WS2022",
        sqlImageSku: "Developer",
        wsfcDomainProfile: {
          domainFqdn: ag.domainFqdn,
          clusterBootstrapAccount: ag.bootstrapAccount,
          clusterOperatorAccount: ag.operatorAccount,
          sqlServiceAccount: ag.sqlServiceAccount,
          storageAccountUrl: ag.witnessUrl,
          storageAccountPrimaryKey: Redacted.make(ag.witnessKey),
          clusterSubnetType: "SingleSubnet",
        },
      },
    );
    const credentials = {
      clusterBootstrapAccountPassword: Redacted.make(ag.password),
      clusterOperatorAccountPassword: Redacted.make(ag.password),
      sqlServiceAccountPassword: Redacted.make(ag.password),
    };
    const sql1 = yield* Azure.SqlVirtualMachine.SqlVirtualMachine("Sql1", {
      resourceGroup: ag.resourceGroup,
      location: LOCATION,
      virtualMachineId: ag.vm1,
      sqlVirtualMachineGroupResourceId: cluster.sqlVirtualMachineGroupId,
      wsfcDomainCredentials: credentials,
    });
    const sql2 = yield* Azure.SqlVirtualMachine.SqlVirtualMachine("Sql2", {
      resourceGroup: ag.resourceGroup,
      location: LOCATION,
      virtualMachineId: ag.vm2,
      sqlVirtualMachineGroupResourceId: cluster.sqlVirtualMachineGroupId,
      wsfcDomainCredentials: credentials,
    });
    const listener = yield* Azure.SqlVirtualMachine.AvailabilityGroupListener(
      "Listener",
      {
        resourceGroup: ag.resourceGroup,
        sqlVirtualMachineGroup: cluster.sqlVirtualMachineGroupName,
        availabilityGroupName: "alchemy-ag",
        createDefaultAvailabilityGroupIfNotExist: true,
        port: props.port,
        loadBalancerConfigurations: [
          {
            loadBalancerResourceId: ag.loadBalancerId,
            privateIpAddress: {
              ipAddress: "10.0.1.50",
              subnetResourceId: ag.subnetId,
            },
            probePort: 59999,
            sqlVirtualMachineInstances: [
              sql1.sqlVirtualMachineId,
              sql2.sqlVirtualMachineId,
            ],
          },
        ],
      },
    );
    return { cluster, listener };
  });

// Paid / external prerequisites: two 2-vCPU SQL VMs + a DC (~$0.60/hour)
// for ~45 minutes, plus a pre-built AD domain. Runs only with
// AZURE_TEST_PAID=1 and the AZURE_TEST_SQLVM_AG_* variables.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete an availability group listener",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { cluster, listener } = yield* stack.deploy(
        paidProgram({ port: 1433 }),
      );
      const get = () =>
        getListener(
          ag.resourceGroup,
          cluster.sqlVirtualMachineGroupName,
          listener.availabilityGroupListenerName,
        );
      const observed = yield* get();
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.port).toEqual(1433);

      // In place: listener port.
      const updated = yield* stack.deploy(paidProgram({ port: 1435 }));
      expect(updated.listener.availabilityGroupListenerId).toEqual(
        listener.availabilityGroupListenerId,
      );
      expect((yield* get()).properties?.port).toEqual(1435);

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, ~1 minute): a group without member SQL VMs rejects
// a listener whose instances are not registered SQL VMs with a 400.
test.provider(
  "a SQL VM group without member VMs rejects a listener",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        const group = yield* Azure.Resources.ResourceGroup("Group", {
          location: LOCATION,
        });
        const cluster = yield* Azure.SqlVirtualMachine.SqlVirtualMachineGroup(
          "Cluster",
          {
            resourceGroup: group.resourceGroupName,
            location: LOCATION,
            sqlImageOffer: "SQL2022-WS2022",
            sqlImageSku: "Developer",
            wsfcDomainProfile: {
              domainFqdn: "alchemy-test.local",
              clusterSubnetType: "SingleSubnet",
            },
          },
        );
        return { group, cluster };
      });
      const { group, cluster } = yield* stack.deploy(program);

      const subscriptionId = yield* subscription;
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            const deployed = yield* program;
            yield* Azure.SqlVirtualMachine.AvailabilityGroupListener(
              "Listener",
              {
                resourceGroup: deployed.group.resourceGroupName,
                sqlVirtualMachineGroup:
                  deployed.cluster.sqlVirtualMachineGroupName,
                availabilityGroupName: "alchemy-ag",
                multiSubnetIpConfigurations: [
                  {
                    privateIpAddress: { ipAddress: "10.0.1.50" },
                    sqlVirtualMachineInstance: `/subscriptions/${subscriptionId}/resourceGroups/${group.resourceGroupName}/providers/Microsoft.SqlVirtualMachine/sqlVirtualMachines/missing`,
                  },
                ],
              },
            );
            return deployed;
          }),
        )
        .pipe(Effect.flip);
      // ARM answers 400 without an error code; the message names the cause.
      expect(error).toMatchObject({ _tag: "BadRequest" });
      expect(String("message" in error ? error.message : "")).toContain(
        "is not part of the SQL virtual machine group",
      );
      const listeners = yield* sqlvm.ListAvailabilityGroupListenerByGroup({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        sqlVirtualMachineGroupName: cluster.sqlVirtualMachineGroupName,
      });
      expect(listeners.value).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
