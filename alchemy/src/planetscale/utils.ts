import type { PlanetScaleClient } from "./api/client.gen.ts";

export type PlanetScaleClusterSize =
  | "PS_DEV"
  | "PS_10"
  | "PS_20"
  | "PS_40"
  | "PS_80"
  | "PS_160"
  | "PS_320"
  | "PS_400"
  | "PS_640"
  | "PS_700"
  | "PS_900"
  | "PS_1280"
  | "PS_1400"
  | "PS_1800"
  | "PS_2100"
  | "PS_2560"
  | "PS_2700"
  | "PS_2800"
  | (string & {});

/**
 * Wait for a database to be ready with exponential backoff
 */
export async function waitForDatabaseReady(
  api: PlanetScaleClient,
  organization: string,
  database: string,
  branch?: string,
): Promise<void> {
  const startTime = Date.now();
  let waitMs = 1000;
  while (true) {
    const response = branch
      ? await api.organizations.databases.branches.get({
          path: {
            organization,
            database,
            name: branch,
          },
          result: "full",
        })
      : await api.organizations.databases.get({
          path: {
            organization,
            name: database,
          },
          result: "full",
        });

    if (response.error) {
      throw new Error(
        `Failed to check state for database "${database}" ${branch ? `branch "${branch}"` : ""}`,
        {
          cause: response.error,
        },
      );
    }

    if (response.data.ready) {
      return;
    }

    if (Date.now() - startTime >= 600_000) {
      throw new Error(
        `Timeout waiting for database "${database}" ${branch ? `branch "${branch}"` : ""} to be ready`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, waitMs));
    waitMs = Math.min(waitMs * 2, 5_000); // Cap at 5s intervals, same as PlanetScale terraform provider
  }
}

/**
 * Wait for a keyspace to be ready
 */
export async function waitForKeyspaceReady(
  api: PlanetScaleClient,
  organization: string,
  database: string,
  branch: string,
  keyspace: string,
): Promise<void> {
  const start = Date.now();
  let delay = 1000;

  while (true) {
    const res =
      await api.organizations.databases.branches.keyspaces.resizes.list({
        path: {
          organization,
          database,
          branch,
          name: keyspace,
        },
      });
    // once it's fully ready, we can proceed
    if (res.data.every((item) => item.state !== "resizing")) {
      return;
    }

    if (Date.now() - start > 600_000) {
      throw new Error(`Timeout waiting for keyspace "${keyspace}" to be ready`);
    }

    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 5_000);
  }
}

/**
 * Ensure a branch is production and has the correct cluster size.
 * If a branch is not production, it will be promoted to production because
 * cluster sizes can only be configured for production branches.
 */
export async function ensureProductionBranchClusterSize(
  api: PlanetScaleClient,
  organization: string,
  database: string,
  branch: string,
  expectedClusterSize: PlanetScaleClusterSize,
  isDBReady: boolean,
): Promise<void> {
  if (!isDBReady) {
    await waitForDatabaseReady(api, organization, database);
  }

  // 1. Ensure branch is production
  const branchData = await api.organizations.databases.branches.get({
    path: {
      organization,
      database,
      name: branch,
    },
  });
  if (!branchData.production) {
    if (!branchData.ready) {
      await waitForDatabaseReady(api, organization, database, branch);
    }
    await api.organizations.databases.branches.promote.post({
      path: {
        organization,
        database,
        name: branch,
      },
    });
  }
  // 2. Load default keyspace
  const keyspaces = await api.organizations.databases.branches.keyspaces.list({
    path: {
      organization,
      database,
      branch,
    },
  });
  const defaultKeyspace = keyspaces.data.find((x) => x.name === database); // Default keyspace is always the same name as the database
  if (!defaultKeyspace) {
    throw new Error(`No default keyspace found for branch ${branch}`);
  }

  // 3. Wait until any in-flight resize is done
  await waitForKeyspaceReady(
    api,
    organization,
    database,
    branch,
    defaultKeyspace.name,
  );

  // 4. If size mismatch, trigger resize and wait again
  // Ideally this would use the undocumented Keyspaces API, but there seems to be a missing oauth scope that we cannot add via the console yet
  if (defaultKeyspace.cluster_name !== expectedClusterSize) {
    await api.organizations.databases.branches.cluster.patch({
      path: {
        organization,
        database,
        name: branch,
      },
      body: { cluster_size: expectedClusterSize },
    });

    // Poll until the resize completes
    await waitForKeyspaceReady(
      api,
      organization,
      database,
      branch,
      defaultKeyspace.name,
    );
  }
}
