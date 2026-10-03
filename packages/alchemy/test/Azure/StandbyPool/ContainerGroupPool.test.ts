import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as standbypool from "@distilled.cloud/azure/standbypool";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getPool = (
  resourceGroupName: string,
  standbyContainerGroupPoolName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* standbypool.GetStandbyContainerGroupPool({
      subscriptionId,
      resourceGroupName,
      standbyContainerGroupPoolName,
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

/**
 * Object ID of the "Standby Pool Resource Provider" service principal
 * (app ID d4398a72-b879-49e5-9f3a-ff22c32efb42) in the test tenant.
 */
const STANDBY_POOL_PRINCIPAL_ID =
  process.env.AZURE_STANDBY_POOL_PRINCIPAL_ID ??
  "484657c4-5e65-42a7-9ef5-f554038edfd8";

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
  maxReadyCapacity: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const profile = yield* Azure.ContainerInstance.ContainerGroupProfile(
      "Profile",
      {
        resourceGroup: group.resourceGroupName,
        location: "eastus",
        containers: [
          {
            name: "app",
            image: "mcr.microsoft.com/azuredocs/aci-helloworld:latest",
            cpu: 0.5,
            memoryInGB: 0.5,
          },
        ],
      },
    );
    // The Standby Pool resource provider reads the profile and creates the
    // pooled container groups on the caller's behalf.
    const grant = yield* Azure.Authorization.RoleAssignment("PoolGrant", {
      scope: group.resourceGroupId,
      // `Azure Container Instances Contributor Role` lacks
      // `containerGroupProfiles/read`; Contributor on the test group covers
      // profiles, container groups, and networking.
      roleDefinitionId: Azure.Authorization.BuiltInRole.Contributor,
      principalId: STANDBY_POOL_PRINCIPAL_ID,
      principalType: "ServicePrincipal",
    });
    if (!props.withPool) return { group, profile, pool: undefined };
    const pool = yield* Azure.StandbyPool.ContainerGroupPool("Pool", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      name: props.name,
      containerGroupProfileId: profile.containerGroupProfileId,
      containerGroupProfileRevision: profile.revision,
      maxReadyCapacity: props.maxReadyCapacity,
      // The tag makes the pool depend on the grant, so the grant outlives it.
      tags: { ...props.tags, grant: grant.roleAssignmentName },
    });
    return { group, profile, pool };
  });

// The pool is free; it keeps at most two 0.5 vCPU / 0.5 GB container groups
// warm (~$0.03/hour each) for a few minutes.
test.provider(
  "create, update, replace, and delete a standby container group pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Grant first, then create the pool once the grant has propagated.
      yield* stack.deploy(
        program({ maxReadyCapacity: 1, tags: { env: "test" } }),
      );
      const { group, profile, pool } = yield* untilAuthorized(
        stack.deploy(
          program({
            withPool: true,
            maxReadyCapacity: 1,
            tags: { env: "test" },
          }),
        ),
      );
      if (pool === undefined) return yield* Effect.die("pool missing");
      expect(pool.standbyContainerGroupPoolId).toContain(
        "/standbyContainerGroupPools/",
      );
      expect(pool.provisioningState).toEqual("Succeeded");
      const observed = yield* getPool(
        group.resourceGroupName,
        pool.standbyContainerGroupPoolName,
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Pool");
      expect(observed.properties?.elasticityProfile.maxReadyCapacity).toEqual(
        1,
      );
      expect(
        observed.properties?.containerGroupProperties.containerGroupProfile.id.toLowerCase(),
      ).toEqual(profile.containerGroupProfileId.toLowerCase());

      // In place: capacity and tags.
      const updated = yield* stack.deploy(
        program({ withPool: true, maxReadyCapacity: 2, tags: { env: "prod" } }),
      );
      expect(updated.pool?.standbyContainerGroupPoolId).toEqual(
        pool.standbyContainerGroupPoolId,
      );
      const reobserved = yield* getPool(
        group.resourceGroupName,
        pool.standbyContainerGroupPoolName,
      );
      expect(reobserved.properties?.elasticityProfile.maxReadyCapacity).toEqual(
        2,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // A new name replaces the pool.
      const replaced = yield* stack.deploy(
        program({
          withPool: true,
          name: "alchemy-sbp-test",
          maxReadyCapacity: 2,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.pool?.standbyContainerGroupPoolName).toEqual(
        "alchemy-sbp-test",
      );
      expect(
        yield* poolGone(
          group.resourceGroupName,
          pool.standbyContainerGroupPoolName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* poolGone(group.resourceGroupName, "alchemy-sbp-test"),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:standbypool", "live"],
    timeout: 900_000,
  },
);
