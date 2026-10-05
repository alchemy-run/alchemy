import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as synapse from "@distilled.cloud/azure/synapse";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

// The free trial refuses new SQL servers (and so Synapse workspaces) in eastus
// (`SqlServerRegionDoesNotAllowProvisioning`).
export const LOCATION = "centralus";

/**
 * The free trial caps Synapse workspaces per subscription (a third
 * concurrent create fails with `WorkspaceCreateOrUpdateApiFailed`: "Reached
 * the maximum number of Synapse workspaces"). Tests that create a workspace
 * hold one slot for their whole body.
 */
const workspaceSlots = Semaphore.makeUnsafe(2);

/** Run a test body while holding one Synapse workspace slot. */
export const withWorkspaceSlot = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => workspaceSlots.withPermits(1)(self);

/** Deterministic test password (the workspace is torn down by every test). */
export const PASSWORD = Redacted.make("Alchemy!Synapse-Test-2026");
export const ROTATED_PASSWORD = Redacted.make("Alchemy!Synapse-Rotated-2026");

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Resource group + ADLS Gen2 account + file system + Synapse workspace,
 * the parent of every Synapse child resource test.
 */
export const lakeWorkspace = (
  props: {
    tags?: Record<string, string>;
    publicNetworkAccess?: "Enabled" | "Disabled";
    password?: Redacted.Redacted<string>;
  } = {},
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const lake = yield* Azure.Storage.StorageAccount("Lake", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      isHnsEnabled: true,
    });
    const fs = yield* Azure.Storage.BlobContainer("Fs", {
      resourceGroup: group.resourceGroupName,
      storageAccount: lake.storageAccountName,
    });
    const workspace = yield* Azure.Synapse.Workspace("Ws", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      defaultDataLakeStorage: {
        accountUrl: lake.primaryEndpoints.dfs.as<string>(),
        filesystem: fs.containerName,
      },
      sqlAdministratorLogin: "sqladminuser",
      sqlAdministratorLoginPassword: props.password ?? PASSWORD,
      publicNetworkAccess: props.publicNetworkAccess,
      tags: props.tags,
    });
    return { group, lake, fs, workspace };
  });

/** Poll a typed GET until it reports not-found. */
export const untilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A, E | AzureOpError, R>,
) =>
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

export const getWorkspace = (
  resourceGroupName: string,
  workspaceName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* synapse.GetWorkspace({
      subscriptionId,
      resourceGroupName,
      workspaceName,
    });
  });

/**
 * Workspace + DW100c dedicated SQL pool, the parent of every SQL pool
 * child test. A DW100c pool costs ~$1.20-1.51 per started hour and takes
 * ~5-10 min to create, so every test using it is gated behind
 * `AZURE_TEST_EXPENSIVE=1`.
 */
export const lakeSqlPool = (
  props: {
    sku?: string;
    tags?: Record<string, string>;
    storageAccountType?: "GRS" | "LRS";
  } = {},
) =>
  Effect.gen(function* () {
    const parent = yield* lakeWorkspace();
    const pool = yield* Azure.Synapse.SqlPool("Dw", {
      resourceGroup: parent.group.resourceGroupName,
      workspace: parent.workspace.workspaceName,
      sku: props.sku ?? "DW100c",
      storageAccountType: props.storageAccountType ?? "LRS",
      tags: props.tags,
    });
    return { ...parent, pool };
  });

/** ARM path of a SQL pool child, for out-of-band SDK checks. */
export const poolPath = (pool: {
  resourceGroup: string;
  workspaceName: string;
  sqlPoolName: string;
}) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return {
      subscriptionId,
      resourceGroupName: pool.resourceGroup,
      workspaceName: pool.workspaceName,
      sqlPoolName: pool.sqlPoolName,
    };
  });
