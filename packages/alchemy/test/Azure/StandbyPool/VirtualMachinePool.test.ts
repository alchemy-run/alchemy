import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as standbypool from "@distilled.cloud/azure/standbypool";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withVcpus } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const LOCATION = process.env.AZURE_TEST_VM_LOCATION ?? "eastus";
/** The B-series is capacity-restricted on the trial; the F v7 1-vCPU size is not. */
const VM_SIZE = process.env.AZURE_TEST_VM_SIZE ?? "Standard_F1als_v7";
/** Checked-in OpenSSH public key (private half discarded). */
const PUBLIC_KEY =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDENxJhC8/syZZ882HXvsvtHroY2qgTIi0Pbxn3I8ypeeKuerxliUK1Ht9xFcz2phTMNwoHzDcS5hdHT6GiYX+kxhbrrWA/b7D1MoqRu0WlIhB/vocs4WU06nWGQi0UXKWfVyfIHGZKgnw9vTcIutmW8KbQySIzgCYtYMD6a9PLL61O0LJaDcH5XDXEeygGLN9yVWitUJy0RNCZmS4qHB3QYzrXisDD0lzxRleIlp4KDpWvriuI8Chswe5rQ6RAEZXpEXYQfEwXm7jO7yO7ZSACh22am2suq4TRcTKlEFPw0V8ksCNzstQdbGsCStfB396XqmPEvz2IqSzMDljGodF/ alchemy-test-1";

/**
 * Object ID of the "Standby Pool Resource Provider" service principal
 * (app ID d4398a72-b879-49e5-9f3a-ff22c32efb42) in the test tenant.
 */
const STANDBY_POOL_PRINCIPAL_ID =
  process.env.AZURE_STANDBY_POOL_PRINCIPAL_ID ??
  "484657c4-5e65-42a7-9ef5-f554038edfd8";

const getPool = (
  resourceGroupName: string,
  standbyVirtualMachinePoolName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* standbypool.GetStandbyVirtualMachinePool({
      subscriptionId,
      resourceGroupName,
      standbyVirtualMachinePoolName,
    });
  });

const poolGone = (resourceGroupName: string, name: string) =>
  getPool(resourceGroupName, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

/** Retry a deploy while the fresh grant has not propagated to the RP. */
const untilAuthorized = <A, E extends { readonly _tag: string }, R>(
  deploy: Effect.Effect<A, E, R>,
) =>
  deploy.pipe(
    Effect.retry({
      // The RP reports a missing grant as a generic `BadRequest`.
      while: (e) => e._tag === "BadRequest",
      schedule: Schedule.spaced("15 seconds"),
      times: 12,
    }),
  );

const program = (props: {
  withPool?: boolean;
  name?: string;
  postProvisioningDelay?: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Vms", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
    });
    const scaleSet = yield* Azure.Compute.VirtualMachineScaleSet("Vmss", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      vmSize: VM_SIZE,
      capacity: 0,
      subnetId: subnet.subnetId,
      adminUsername: "azureuser",
      sshPublicKeys: [PUBLIC_KEY],
    });
    // The Standby Pool resource provider creates and deallocates the
    // standby VMs (compute, network, disks) on the caller's behalf.
    const grant = yield* Azure.Authorization.RoleAssignment("PoolGrant", {
      scope: group.resourceGroupId,
      roleDefinitionId: Azure.Authorization.BuiltInRole.Contributor,
      principalId: STANDBY_POOL_PRINCIPAL_ID,
      principalType: "ServicePrincipal",
    });
    if (!props.withPool) return { group, scaleSet, pool: undefined };
    const pool = yield* Azure.StandbyPool.VirtualMachinePool("Pool", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      name: props.name,
      attachedVirtualMachineScaleSetId: scaleSet.virtualMachineScaleSetId,
      virtualMachineState: "Deallocated",
      maxReadyCapacity: 1,
      postProvisioningDelay: props.postProvisioningDelay,
      // The tag makes the pool depend on the grant, so the grant outlives it.
      tags: { ...props.tags, grant: grant.roleAssignmentName },
    });
    return { group, scaleSet, pool };
  });

// A Flexible scale set with zero instances plus a pool of one deallocated
// 1-vCPU VM (two during the replacement step): VMs bill only briefly while
// provisioning, then just their disks. Well under $0.10 per run, ~10 min.
test.provider(
  "create, update, replace, and delete a standby virtual machine pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Grant first, then create the pool once the grant has propagated.
      yield* stack.deploy(program({ tags: { env: "test" } }));
      const { group, scaleSet, pool } = yield* untilAuthorized(
        stack.deploy(program({ withPool: true, tags: { env: "test" } })),
      );
      if (pool === undefined) return yield* Effect.die("pool missing");
      expect(pool.standbyVirtualMachinePoolId).toContain(
        "/standbyVirtualMachinePools/",
      );
      expect(pool.provisioningState).toEqual("Succeeded");
      expect(pool.virtualMachineState).toEqual("Deallocated");
      const observed = yield* getPool(
        group.resourceGroupName,
        pool.standbyVirtualMachinePoolName,
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Pool");
      expect(
        observed.properties?.attachedVirtualMachineScaleSetId?.toLowerCase(),
      ).toEqual(scaleSet.virtualMachineScaleSetId.toLowerCase());
      expect(observed.properties?.elasticityProfile?.maxReadyCapacity).toEqual(
        1,
      );

      // In place: provisioning delay and tags.
      const updated = yield* stack.deploy(
        program({
          withPool: true,
          postProvisioningDelay: "PT5S",
          tags: { env: "prod" },
        }),
      );
      expect(updated.pool?.standbyVirtualMachinePoolId).toEqual(
        pool.standbyVirtualMachinePoolId,
      );
      const reobserved = yield* getPool(
        group.resourceGroupName,
        pool.standbyVirtualMachinePoolName,
      );
      expect(
        reobserved.properties?.elasticityProfile?.postProvisioningDelay,
      ).toEqual("PT5S");
      expect(reobserved.tags?.env).toEqual("prod");

      // A new name replaces the pool.
      const replaced = yield* stack.deploy(
        program({
          withPool: true,
          name: "alchemy-sbvm-test",
          postProvisioningDelay: "PT5S",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.pool?.standbyVirtualMachinePoolName).toEqual(
        "alchemy-sbvm-test",
      );
      expect(
        yield* poolGone(
          group.resourceGroupName,
          pool.standbyVirtualMachinePoolName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* poolGone(group.resourceGroupName, "alchemy-sbvm-test"),
      ).toEqual("gone");
    }).pipe(withVcpus(2), logLevel),
  {
    tags: ["provider:azure", "provider:azure:standbypool", "live"],
    timeout: 900_000,
  },
);
