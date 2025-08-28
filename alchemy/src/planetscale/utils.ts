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
  await poll({
    description: `database "${database}" ${branch ? `branch "${branch}"` : ""} ready`,
    fn: async () => {
      if (branch) {
        return await api.organizations.databases.branches.get({
          path: { organization, database, name: branch },
        });
      }
      return await api.organizations.databases.get({
        path: { organization, name: database },
      });
    },
    predicate: (item) => item.ready,
  });
}

/**
 * Polls a keyspace until it is finished resizing.
 */
export async function waitForKeyspaceReady(
  api: PlanetScaleClient,
  organization: string,
  database: string,
  branch: string,
  keyspace: string,
): Promise<void> {
  await poll({
    description: `keyspace "${keyspace}" ready`,
    fn: () =>
      api.organizations.databases.branches.keyspaces.resizes.list({
        path: { organization, database, branch, name: keyspace },
      }),
    predicate: (response) =>
      response.data.every((item) => item.state !== "resizing"),
    initialDelay: 100,
    maxDelay: 1000,
  });
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

/**
 * Polls a function until it returns a result that satisfies the predicate.
 */
async function poll<T>(input: {
  /**
   * A description of the operation being polled.
   */
  description: string;

  /**
   * The function to poll.
   */
  fn: () => Promise<T>;

  /**
   * A predicate that determines if the operation has completed.
   */
  predicate: (result: T) => boolean;

  /**
   * The initial delay between polls.
   * @default 250ms
   */
  initialDelay?: number;

  /**
   * The maximum delay between polls.
   * @default 2_500ms (2.5 seconds)
   */
  maxDelay?: number;

  /**
   * The timeout for the poll in milliseconds.
   * @default 1_000_000 (~16 minutes)
   */
  timeout?: number;
}): Promise<T> {
  const start = Date.now();
  let delay = input.initialDelay ?? 250;
  while (true) {
    const result = await input.fn();
    if (input.predicate(result)) {
      return result;
    }
    if (Date.now() - start >= (input.timeout ?? 1_000_000)) {
      throw new Error(
        `Timed out waiting for ${input.description} after ${Math.round(
          (input.timeout ?? 1_000_000) / 1000,
        )}s`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, input.maxDelay ?? 5_000);
  }
}
