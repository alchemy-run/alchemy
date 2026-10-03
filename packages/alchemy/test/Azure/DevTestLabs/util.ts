import * as Azure from "@/Azure";
import { Credentials, type AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:devtestlabs", "live"];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
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

/** Resource group + lab (free; 2-5 minutes to create) for child tests. */
export const labFixture = (location = "eastus") =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const lab = yield* Azure.DevTestLabs.Lab("Lab", {
      resourceGroup: group.resourceGroupName,
      labStorageType: "Standard",
    });
    return { group, lab };
  });

/**
 * The deploying principal (`oid` / `tid` claims of the ARM token). DevTest
 * Labs only accepts lab users it can resolve in the tenant: the deploying
 * service principal works, while managed identities and first-party service
 * principals are rejected with "User was not found in the tenant."
 */
export const caller = Effect.gen(function* () {
  const config = yield* yield* Credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(
        Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
      ) as { oid: string; tid: string },
  );
});

/** Lab + a lab user for the deploying principal (all free). */
export const labUserFixture = (location = "eastus") =>
  Effect.gen(function* () {
    const { oid, tid } = yield* caller;
    const { group, lab } = yield* labFixture(location);
    const user = yield* Azure.DevTestLabs.User("LabUser", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      objectId: oid,
      tenantId: tid,
    });
    return { group, lab, user };
  });

/** Size of lab VMs in tests (2 vCPU, SCSI; ~$0.10/hour). */
export const LAB_VM_SIZE =
  process.env.AZURE_TEST_LAB_VM_SIZE ?? "Standard_D2as_v4";
/**
 * Resize target. Standard_D2s_v3 hit "SkuNotAvailable ... Capacity
 * Restrictions" in eastus.
 */
export const LAB_VM_SIZE_ALT =
  process.env.AZURE_TEST_LAB_VM_SIZE_ALT ?? "Standard_D2as_v5";

/** Lab + registered VNet/subnet for lab VMs (all free). */
export const labNetworkFixture = (location = "eastus") =>
  Effect.gen(function* () {
    const { group, lab } = yield* labFixture(location);
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location,
      addressPrefixes: ["10.30.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("VmSubnet", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.30.1.0/24",
    });
    const network = yield* Azure.DevTestLabs.LabVirtualNetwork("LabNet", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      externalProviderResourceId: vnet.virtualNetworkId,
      subnetOverrides: [
        {
          resourceId: subnet.subnetId,
          labSubnetName: subnet.subnetName,
          useInVmCreationPermission: "Allow",
          usePublicIpAddressPermission: "Deny",
        },
      ],
    });
    return { group, lab, subnet, network };
  });
