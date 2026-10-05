import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as mdp from "@distilled.cloud/azure/devopsinfrastructure";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:devopsinfrastructure", "live"];

const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

const getPool = (resourceGroupName: string, poolName: string) =>
  Effect.gen(function* () {
    return yield* mdp.GetPool({
      subscriptionId: yield* subscription,
      resourceGroupName,
      poolName,
    });
  });

/** Poll an out-of-band GET until it reports a typed not-found. */
const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 60,
    }),
  );

const fabricProfile = {
  kind: "Vmss" as const,
  sku: { name: "Standard_D2ads_v5" },
  images: [{ wellKnownImageName: "ubuntu-22.04/latest" }],
};

// Ungated: the testing account has no Azure DevOps organization. The PUT is
// accepted (201), then the service's async validation fails with
// `OrganizationNotFound` ("The Azure DevOps organization
// https://dev.azure.com/alchemy-probe-missing-org provided on pool ...
// doesn't exist.") and the service deletes the pool. The organization is
// validated before the Dev Center project, so no dev center is needed.
// ~1-2 minutes, $0.
test.provider(
  "pool creation is rejected when the Azure DevOps organization does not exist",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            const group = yield* Azure.Resources.ResourceGroup("Group", {
              location: "eastus",
            });
            const pool = yield* Azure.DevOpsInfrastructure.Pool("Pool", {
              resourceGroup: group.resourceGroupName,
              name: "alchemy-mdp-probe",
              location: "eastus",
              devCenterProjectResourceId: Output.interpolate`/subscriptions/${subscriptionId}/resourceGroups/${group.resourceGroupName}/providers/Microsoft.DevCenter/projects/alchemy-missing`,
              maximumConcurrency: 1,
              organizationProfile: {
                kind: "AzureDevOps",
                organizations: [
                  { url: "https://dev.azure.com/alchemy-probe-missing-org" },
                ],
              },
              fabricProfile,
            });
            return { group, pool };
          }),
        )
        .pipe(Effect.flip);
      expect(JSON.stringify(error)).toContain(
        "Azure.DevOpsInfrastructure.PoolCreateRejected",
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 900_000 },
);

const program = (props: {
  name?: string;
  maximumConcurrency: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const center = yield* Azure.DevCenter.DevCenter("Center", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
    });
    const project = yield* Azure.DevCenter.Project("Project", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      devCenterId: center.devCenterId,
    });
    const pool = yield* Azure.DevOpsInfrastructure.Pool("Pool", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      // Managed DevOps Pools has its own per-SKU-family quota, separate from
      // Compute quota. New subscriptions get 5 Dadsv5 cores in centralus and
      // 0 in eastus (InsufficientCoreQuota on standardDADSv5Family).
      location: "centralus",
      devCenterProjectResourceId: project.projectId,
      maximumConcurrency: props.maximumConcurrency,
      organizationProfile: {
        kind: "AzureDevOps",
        organizations: [{ url: process.env.AZURE_DEVOPS_ORG_URL ?? "" }],
      },
      agentProfile: { kind: "Stateless" },
      fabricProfile,
      tags: props.tags,
    });
    return { group, project, pool };
  });

// Gated: needs an Azure DevOps organization connected to the subscription's
// Entra tenant (`AZURE_DEVOPS_ORG_URL`, see the probe above) in which the
// test service principal is a Project Collection Administrator. The dev
// center/project are free and an idle Stateless pool with no stand-by agents
// costs ~$0, but create, update, replace and delete each take several
// minutes (~25-35 minutes end to end).
test.provider.skipIf(!runPaidOnly || !process.env.AZURE_DEVOPS_ORG_URL)(
  "create, update, replace, and delete a managed devops pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ maximumConcurrency: 2, tags: { a: "1" } }),
      );
      expect(created.pool.maximumConcurrency).toEqual(2);
      expect(created.pool.organizationKind).toEqual("AzureDevOps");
      const observed = yield* getPool(
        created.group.resourceGroupName,
        created.pool.poolName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(
        observed.properties?.devCenterProjectResourceId?.toLowerCase(),
      ).toEqual(created.project.projectId.toLowerCase());
      expect(observed.tags?.a).toEqual("1");

      // In-place update of concurrency and tags. Concurrency goes down so
      // the create-before-delete replacement below fits the region's 5-core
      // Managed DevOps Pools quota (2 cores per agent, old + new pool).
      const updated = yield* stack.deploy(
        program({ maximumConcurrency: 1, tags: { a: "2" } }),
      );
      expect(updated.pool.poolId).toEqual(created.pool.poolId);
      expect(updated.pool.maximumConcurrency).toEqual(1);
      // ARM read replicas can briefly return the pre-PATCH pool.
      const afterUpdate = yield* getPool(
        updated.group.resourceGroupName,
        updated.pool.poolName,
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (pool) => pool.properties?.maximumConcurrency === 1,
          times: 12,
        }),
      );
      expect(afterUpdate.properties?.maximumConcurrency).toEqual(1);
      expect(afterUpdate.tags?.a).toEqual("2");

      // Renaming replaces the pool.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-mdp-renamed",
          maximumConcurrency: 1,
          tags: { a: "2" },
        }),
      );
      expect(replaced.pool.poolName).toEqual("alchemy-mdp-renamed");
      expect(
        yield* waitGone(
          getPool(created.group.resourceGroupName, created.pool.poolName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getPool(replaced.group.resourceGroupName, replaced.pool.poolName),
        ),
      ).toEqual("gone");
    }),
  { tags, timeout: 2_700_000 },
);
