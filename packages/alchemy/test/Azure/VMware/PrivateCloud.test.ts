import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as vmware from "@distilled.cloud/azure/vmware";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { AVS_TIMEOUT, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  internet: "Enabled" | "Disabled";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const cloud = yield* Azure.VMware.PrivateCloud("Cloud", {
      resourceGroup: group.resourceGroupName,
      sku: "av36p",
      networkBlock: "10.175.0.0/22",
      clusterSize: 3,
      internet: props.internet,
      tags: props.tags,
    });
    return { group, cloud };
  });

// 3 x AV36P private cloud: ~$30/hour, 3-4 hours to provision plus 1-2 to
// delete (~$180 per run). Free trials have no AVS host quota.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a private cloud",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cloud } = yield* stack.deploy(
        program({ internet: "Disabled", tags: { env: "test" } }),
      );
      const subscriptionId = yield* subscription;
      const get = () =>
        vmware.GetPrivateCloud({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          privateCloudName: cloud.privateCloudName,
        });
      const observed = yield* get();
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.networkBlock).toEqual("10.175.0.0/22");
      expect(observed.tags?.env).toEqual("test");
      expect(cloud.endpoints.vcsa).toBeDefined();

      // In-place: enable internet and change tags.
      const updated = yield* stack.deploy(
        program({ internet: "Enabled", tags: { env: "updated" } }),
      );
      expect(updated.cloud.privateCloudId).toEqual(cloud.privateCloudId);
      const reobserved = yield* get();
      expect(reobserved.properties?.internet).toEqual("Enabled");
      expect(reobserved.tags?.env).toEqual("updated");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: AVS_TIMEOUT },
);

// Ungated probe (a resource group only): the free trial has no AVS host
// quota, so creating a private cloud fails with the typed quota error and
// nothing is left behind.
test.provider(
  "the free trial rejects private clouds with a typed quota error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      const where = {
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        privateCloudName: "alchemy-quota-probe",
      };
      yield* ensureRegistered(subscriptionId, "Microsoft.AVS");
      const error = yield* vmware
        .PrivateCloudsCreateOrUpdate({
          ...where,
          location: "eastus",
          sku: { name: "av36p" },
          properties: {
            managementCluster: { clusterSize: 3 },
            networkBlock: "10.175.0.0/22",
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("QuotaExceeded");
      expect(yield* waitGone(vmware.GetPrivateCloud(where))).toEqual("gone");

      // The provider surfaces the same typed error and leaves nothing behind.
      const deployError = yield* stack
        .deploy(program({ internet: "Disabled", tags: {} }))
        .pipe(Effect.flip);
      expect(JSON.stringify(deployError)).toContain("QuotaExceeded");
      const list = yield* vmware.ListPrivateClouds({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
      });
      expect(list.value).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Ungated probe: every child resource type is served on the pinned
// api-version (a missing parent is a typed not-found, not an
// unsupported-api-version BadRequest).
test.provider(
  "every AVS child resource type answers with a typed not-found",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(subscriptionId, "Microsoft.AVS");
      const parent = {
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        privateCloudName: "alchemy-missing",
      };
      const tagOf = <A, E extends { readonly _tag: string }, R>(
        effect: Effect.Effect<A, E, R>,
      ) =>
        effect.pipe(
          Effect.flip,
          Effect.map((e) => e._tag),
        );
      const results = {
        privateCloud: yield* tagOf(vmware.GetPrivateCloud(parent)),
        cluster: yield* tagOf(
          vmware.GetCluster({ ...parent, clusterName: "c" }),
        ),
        datastore: yield* tagOf(
          vmware.GetDatastore({
            ...parent,
            clusterName: "c",
            datastoreName: "d",
          }),
        ),
        placementPolicy: yield* tagOf(
          vmware.GetPlacementPolicy({
            ...parent,
            clusterName: "c",
            placementPolicyName: "p",
          }),
        ),
        addon: yield* tagOf(vmware.GetAddon({ ...parent, addonName: "hcx" })),
        authorization: yield* tagOf(
          vmware.GetAuthorization({ ...parent, authorizationName: "a" }),
        ),
        cloudLink: yield* tagOf(
          vmware.GetCloudLink({ ...parent, cloudLinkName: "l" }),
        ),
        globalReach: yield* tagOf(
          vmware.GetGlobalReachConnection({
            ...parent,
            globalReachConnectionName: "g",
          }),
        ),
        hcxSite: yield* tagOf(
          vmware.GetHcxEnterpriseSite({
            ...parent,
            hcxEnterpriseSiteName: "h",
          }),
        ),
        iscsiPath: yield* tagOf(vmware.GetIscsiPath(parent)),
        license: yield* tagOf(
          vmware.GetLicense({ ...parent, licenseName: "VmwareFirewall" }),
        ),
        pureStoragePolicy: yield* tagOf(
          vmware.GetPureStoragePolicy({ ...parent, storagePolicyName: "p" }),
        ),
        dhcp: yield* tagOf(
          vmware.GetWorkloadNetworkDhcp({ ...parent, dhcpId: "d" }),
        ),
        dnsService: yield* tagOf(
          vmware.GetWorkloadNetworkDnsService({ ...parent, dnsServiceId: "d" }),
        ),
        dnsZone: yield* tagOf(
          vmware.GetWorkloadNetworkDnsZone({ ...parent, dnsZoneId: "d" }),
        ),
        portMirroring: yield* tagOf(
          vmware.GetWorkloadNetworkPortMirroring({
            ...parent,
            portMirroringId: "p",
          }),
        ),
        publicIP: yield* tagOf(
          vmware.GetWorkloadNetworkPublicIP({ ...parent, publicIPId: "p" }),
        ),
        segment: yield* tagOf(
          vmware.GetWorkloadNetworkSegment({ ...parent, segmentId: "s" }),
        ),
        vmGroup: yield* tagOf(
          vmware.GetWorkloadNetworkVMGroup({ ...parent, vmGroupId: "v" }),
        ),
      };
      for (const [type, tag] of Object.entries(results)) {
        expect([
          type,
          ["ResourceNotFound", "NotFound"].includes(tag) ? "ok" : tag,
        ]).toEqual([type, "ok"]);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
