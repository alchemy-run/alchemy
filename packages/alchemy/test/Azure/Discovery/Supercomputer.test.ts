import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as discovery from "@distilled.cloud/azure/discovery";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  location,
  logLevel,
  probeGroup,
  subscription,
  supercomputerPrerequisites,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSupercomputer = (
  resourceGroupName: string,
  supercomputerName: string,
) =>
  Effect.gen(function* () {
    return yield* discovery.GetSupercomputer({
      subscriptionId: yield* subscription,
      resourceGroupName,
      supercomputerName,
    });
  });

const program = (props: {
  withWorkload: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const prereqs = yield* supercomputerPrerequisites;
    const supercomputer = yield* Azure.Discovery.Supercomputer("Super", {
      resourceGroup: prereqs.group.resourceGroupName,
      subnetId: prereqs.system.subnetId,
      managementSubnetId: prereqs.management.subnetId,
      clusterIdentity: prereqs.cluster.identityId,
      kubeletIdentity: prereqs.kubelet.identityId,
      workloadIdentities: props.withWorkload
        ? [prereqs.workload.identityId]
        : [],
      tags: props.tags,
    });
    return { ...prereqs, supercomputer };
  });

// Microsoft Discovery is a gated preview: ARM does not expose its resource
// types to the trial subscription (InvalidResourceType, see the probe).
// A supercomputer is a managed AKS cluster with a system node pool: 30+
// minutes and ~$1-2 per run, beyond the trial's vCPU quota. Replacement is
// not exercised (it would double the provisioning time). Runs only with
// AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a discovery supercomputer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, supercomputer } = yield* stack.deploy(
        program({ withWorkload: false, tags: { env: "test" } }),
      );
      const get = () =>
        getSupercomputer(
          group.resourceGroupName,
          supercomputer.supercomputerName,
        );
      const observed = yield* get();
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      // In place: workload identities and tags.
      const updated = yield* stack.deploy(
        program({ withWorkload: true, tags: { env: "prod" } }),
      );
      expect(updated.supercomputer.supercomputerId).toEqual(
        supercomputer.supercomputerId,
      );
      const reobserved = yield* get();
      expect(
        Object.keys(
          reobserved.properties?.identities.workloadIdentities ?? {},
        ).map((id) => id.toLowerCase()),
      ).toEqual([updated.workload.identityId.toLowerCase()]);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

test.provider(
  "discovery supercomputers are rejected where the preview is not enabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(probeGroup);
      const subscriptionId = yield* subscription;
      const prefix = `/subscriptions/${subscriptionId}/resourceGroups/${group.resourceGroupName}/providers`;
      const error = yield* discovery
        .SupercomputersCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          supercomputerName: "alchemy-probe",
          location,
          properties: {
            subnetId: `${prefix}/Microsoft.Network/virtualNetworks/probe/subnets/probe`,
            identities: {
              clusterIdentity: {
                id: `${prefix}/Microsoft.ManagedIdentity/userAssignedIdentities/cluster`,
              },
              kubeletIdentity: {
                id: `${prefix}/Microsoft.ManagedIdentity/userAssignedIdentities/kubelet`,
              },
            },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("InvalidResourceType");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
