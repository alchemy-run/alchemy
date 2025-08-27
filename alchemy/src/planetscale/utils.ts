import type { PlanetScaleClient } from "./api/client.gen.ts";
import type { DatabaseBranch } from "./api/types.gen.ts";

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

export function sanitizeClusterSize(input: {
  size: PlanetScaleClusterSize;
  kind?: "mysql" | "postgresql";
  arch?: "x86" | "arm";
  region?: string;
}): string {
  // Postgres cluster sizes are formatted as `PS_<size>_<provider>_<arch>`,
  // where <provider> is either "AWS" or "GCP", and <arch> is either "ARM" or "X86".
  if (
    input.kind === "postgresql" &&
    !input.size.match(/(AWS|GCP)_(ARM|X86)$/)
  ) {
    // Infer the provider from the region.
    // Not all AWS regions start with "aws-", but all GCP regions start with "gcp-".
    const provider = input.region?.startsWith("gcp") ? "GCP" : "AWS";
    const arch = (input.arch ?? "x86").toUpperCase();
    return `${input.size}_${provider}_${arch}`;
  }
  return input.size;
}

export async function waitForBranchReady(
  api: PlanetScaleClient,
  organization: string,
  database: string,
  branch: string,
): Promise<DatabaseBranch> {
  const start = Date.now();
  let delay = 1000;

  while (true) {
    const res = await api.organizations.databases.branches.get({
      path: { organization, database, name: branch },
    });

    if (res.ready) {
      return res;
    }

    if (Date.now() - start > 600_000) {
      throw new Error(`Timeout waiting for branch "${branch}" to be ready`);
    }

    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 5_000);
  }
}

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

async function ensureProductionBranch(
  api: PlanetScaleClient,
  organization: string,
  database: string,
  name: string,
): Promise<void> {
  const data = await api.organizations.databases.branches.get({
    path: {
      organization,
      database,
      name,
    },
  });
  if (!data.production) {
    if (!data.ready) {
      await waitForBranchReady(api, organization, database, name);
    }
    await api.organizations.databases.branches.promote.post({
      path: { organization, database, name },
    });
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
  kind: "mysql" | "postgresql",
  expectedClusterSize: PlanetScaleClusterSize,
): Promise<void> {
  switch (kind) {
    case "mysql": {
      // Vitess databases must be promoted before resizing
      await ensureProductionBranch(api, organization, database, branch);
      await ensureMySQLClusterSize(
        api,
        organization,
        database,
        branch,
        expectedClusterSize,
      );
      break;
    }
    case "postgresql": {
      // Postgres databases must be resized first before promoting, otherwise 500 error
      await ensurePostgresClusterSize(
        api,
        organization,
        database,
        branch,
        expectedClusterSize,
      );
      await ensureProductionBranch(api, organization, database, branch);
      break;
    }
  }
}

async function ensureMySQLClusterSize(
  api: PlanetScaleClient,
  organization: string,
  database: string,
  branch: string,
  expectedClusterSize: PlanetScaleClusterSize,
): Promise<void> {
  // 1. Load default keyspace
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

  // 2. Wait until any in-flight resize is done
  await waitForKeyspaceReady(
    api,
    organization,
    database,
    branch,
    defaultKeyspace.name,
  );

  // 3. If size mismatch, trigger resize and wait again
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

async function ensurePostgresClusterSize(
  api: PlanetScaleClient,
  organization: string,
  database: string,
  branch: string,
  expectedClusterSize: PlanetScaleClusterSize,
): Promise<void> {
  const data = await api.organizations.databases.branches.get({
    path: {
      organization,
      database,
      name: branch,
    },
  });
  if (data.cluster_name === expectedClusterSize) {
    return;
  }
  await waitForPendingPostgresChanges(api, organization, database, branch);
  const change = await api.organizations.databases.branches.changes.patch({
    path: {
      organization,
      database,
      branch,
    },
    body: {
      cluster_size: expectedClusterSize,
    },
  });
  await waitForPendingPostgresChanges(
    api,
    organization,
    database,
    branch,
    change.id,
  );
}

async function waitForPendingPostgresChanges(
  api: PlanetScaleClient,
  organization: string,
  database: string,
  branch: string,
  changeId?: string,
) {
  const startTime = Date.now();
  let waitMs = 1000;
  while (true) {
    const response = await api.organizations.databases.branches.changes.list({
      path: { organization, database, branch },
    });
    const done = changeId
      ? response.data.find(
          (change) =>
            change.id === changeId &&
            (change.state === "completed" || change.state === "canceled"),
        )
      : response.data.every(
          (x) => x.state === "completed" || x.state === "canceled",
        );
    if (done) {
      return;
    }

    // extra long timeout because postgres changes take forever
    if (Date.now() - startTime >= 1_000_000) {
      throw new Error(`Timeout waiting for changes for branch "${branch}"`);
    }

    await new Promise((resolve) => setTimeout(resolve, waitMs));
    waitMs = Math.min(waitMs * 2, 5_000);
  }
}
