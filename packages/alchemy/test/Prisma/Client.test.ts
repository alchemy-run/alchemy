import { getProjectBranches } from "@distilled.cloud/prisma/management";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Prisma from "@/Prisma";
import {
  extractConnectionSecrets,
  isConflict,
  isNotFound,
  PrismaApiError,
  PrismaClient,
} from "@/Prisma/Client";
import * as Test from "@/Test/Alchemy";
import { expectGone, expectProjectGone } from "./fixtures/Live.ts";

const { test } = Test.make({ providers: Prisma.providers() });

const tags = (...resources: string[]) => [
  "provider:prisma",
  "provider:prisma:project",
  ...resources.map((resource) => `provider:prisma:${resource}`),
  "live",
];

const projectStack = Effect.gen(function* () {
  const project = yield* Prisma.Project("Project", { createDatabase: false });
  return { projectId: project.projectId };
});

/** Run an effect that must fail with a Prisma Management API error. */
const apiError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.tap((error) => Effect.sync(() => expect(error).toBeInstanceOf(PrismaApiError))),
    Effect.map((error) => error as PrismaApiError),
  );

/** Poll a read until the API reports 404 for it. */
const expectNotFound = <A, E, R>(read: Effect.Effect<A, E, R>) =>
  expectGone(
    read.pipe(
      Effect.as(false),
      Effect.catchIf(isNotFound, () => Effect.succeed(true)),
    ),
  );

describe("extractConnectionSecrets", { tags: ["unit", "provider:prisma", "local"] }, () => {
  it("extracts canonical endpoint secrets and parses direct credentials", () => {
    const secrets = extractConnectionSecrets({
      id: "connection-1",
      type: "connection",
      url: "https://api.prisma.test/v1/connections/connection-1",
      name: "api",
      createdAt: "2026-01-01T00:00:00Z",
      kind: "postgres",
      endpoints: {
        direct: {
          host: "direct.prisma.test",
          port: 5432,
          connectionString:
            "postgres://api:p%40ss@direct.prisma.test:5432/postgres?sslmode=require",
        },
        pooled: {
          host: "pooled.prisma.test",
          port: 5432,
          connectionString: "postgres://pooled",
        },
      },
      database: {
        id: "database-1",
        url: "https://api.prisma.test/v1/databases/database-1",
        name: "main",
      },
    } as unknown as Parameters<typeof extractConnectionSecrets>[0]);

    expect(Redacted.value(secrets.directConnectionString!)).toContain("direct.prisma.test");
    expect(Redacted.value(secrets.pooledConnectionString!)).toBe("postgres://pooled");
    expect(secrets.host).toBe("direct.prisma.test");
    expect(secrets.user).toBe("api");
    expect(Redacted.value(secrets.password!)).toBe("p@ss");
  });
});

test.provider(
  "reads the workspace, principal, regions, and integrations",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();
    const client = yield* PrismaClient;

    const me = yield* client.getCurrentPrincipal();
    expect(me.workspace).not.toBeNull();
    const workspaceId = me.workspace!.id;

    const workspace = yield* client.getWorkspace(workspaceId);
    expect(workspace.id).toBe(workspaceId);
    const workspaces = yield* client.listWorkspaces({ limit: 1 });
    expect(workspaces.map((candidate) => candidate.id)).toContain(workspaceId);

    const regions = yield* client.listRegions({ product: "postgres" });
    expect(regions.length).toBeGreaterThan(0);
    expect(regions.every((region) => region.product === "postgres")).toBe(true);
    const postgresRegions = yield* client.listPostgresRegions();
    expect(postgresRegions.map((region) => region.id)).toContain("us-east-1");
    const accelerateRegions = yield* client.listAccelerateRegions();
    expect(accelerateRegions.map((region) => region.id)).toContain("us-east-1");

    expect(Array.isArray(yield* client.listIntegrations({ workspaceId }))).toBe(true);
    expect(Array.isArray(yield* client.listWorkspaceIntegrations(workspaceId, { limit: 1 }))).toBe(
      true,
    );
    expect(Array.isArray(yield* client.listScmInstallations({ workspaceId }))).toBe(true);
    expect(isNotFound(yield* apiError(client.getIntegration("itgr_alchemymissing00000000")))).toBe(
      true,
    );
    if (me.credential.type === "service_token") {
      // Service tokens cannot start a GitHub App install.
      const refused = yield* apiError(
        client.createScmInstallIntent({ provider: "github", workspaceId }),
      );
      expect(refused.status).toBe(403);
    }

    yield* stack.destroy();
  }),
  { tags: tags(), timeout: 120_000 },
);

test.provider(
  "maps missing resources to 404s with redacted structured error bodies",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();
    const client = yield* PrismaClient;

    const missing = [
      client.getProject("proj_alchemymissing00000000"),
      client.getBranch("br_alchemymissing0000000000"),
      client.getBucket("bkt_alchemymissing000000000"),
      client.getEnvironmentVariable("envvar_alchemymissing000000"),
      client.getCustomDomain("dom_alchemymissing000000000"),
      client.deleteCustomDomain("dom_alchemymissing000000000"),
      client.retryCustomDomain("dom_alchemymissing000000000"),
      client.getSourceRepository("srcrepo_alchemymissing00000"),
      client.deleteSourceRepository("srcrepo_alchemymissing00000"),
    ];
    for (const request of missing) {
      const error = yield* apiError(request);
      expect(error.status).toBe(404);
      expect(isNotFound(error)).toBe(true);
      // Only the safe error code reaches the message; the body stays redacted.
      expect(error.message).toBe("Prisma Management API request failed (resource-not-found)");
      expect(Redacted.value(error.body!)).toContain("resource-not-found");
      expect(JSON.stringify(error)).not.toContain("Resource Not Found");
    }

    // Path-confusing IDs are refused locally (status 0) before any request.
    for (const request of [
      client.getProject("../workspaces"),
      client.getProject("project-1/databases"),
      client.getDeploymentLogsRequest("deployment-1/../../projects"),
      client.getBuildLogsRequest("build-1?token=leak"),
    ]) {
      const error = yield* apiError(request);
      expect(error.status).toBe(0);
      expect(error.message).toContain("invalid Prisma Management API");
    }

    yield* stack.destroy();
  }),
  { tags: tags(), timeout: 120_000 },
);

test.provider(
  "paginates branches across cursors and reports branch conflicts and deletes",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();
    const client = yield* PrismaClient;
    const { projectId } = yield* stack.deploy(projectStack);

    const first = yield* client.createBranch(projectId, { gitName: "client/first" });
    const second = yield* client.createBranch(projectId, { gitName: "client/second" });
    expect(first.project.id).toBe(projectId);
    expect(first.isDefault).toBe(false);

    // The API pages one branch at a time; the client follows every cursor.
    const firstPage = yield* getProjectBranches({ projectId, limit: 1 });
    expect(firstPage.data).toHaveLength(1);
    expect(firstPage.pagination.hasMore).toBe(true);
    const cursor = firstPage.pagination.nextCursor!;
    const all = yield* client.listBranches(projectId, { limit: 1 });
    expect(all.map((branch) => branch.gitName).sort()).toEqual(
      ["client/first", "client/second", firstPage.data[0]!.gitName].sort(),
    );
    // Starting from an explicit cursor skips the first page.
    const rest = yield* client.listBranches(projectId, { limit: 1, cursor });
    expect(rest.map((branch) => branch.id)).toEqual(
      all.filter((branch) => branch.id !== firstPage.data[0]!.id).map((branch) => branch.id),
    );
    const filtered = yield* client.listBranches(projectId, { gitName: "client/second" });
    expect(filtered.map((branch) => branch.id)).toEqual([second.id]);

    const duplicate = yield* apiError(client.createBranch(projectId, { gitName: "client/first" }));
    expect(duplicate.status).toBe(409);
    expect(isConflict(duplicate)).toBe(true);

    const updated = yield* client.updateBranch(first.id, { isDefault: false });
    expect(updated.id).toBe(first.id);
    expect((yield* client.getBranch(second.id)).gitName).toBe("client/second");

    yield* client.deleteBranch(first.id);
    yield* client.deleteBranch(second.id);
    yield* expectNotFound(client.getBranch(first.id));
    yield* expectNotFound(client.getBranch(second.id));

    yield* stack.destroy();
    yield* expectProjectGone(projectId);
  }),
  { tags: tags("branch"), timeout: 180_000 },
);

test.provider(
  "creates, reads, renames, and deletes databases and their connections",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();
    const client = yield* PrismaClient;
    const { projectId } = yield* stack.deploy(projectStack);

    const nested = yield* client.createProjectDatabase(projectId, {
      name: "client-nested",
      region: "us-east-1",
    });
    expect(nested.name).toBe("client-nested");
    expect(nested.region?.id).toBe("us-east-1");
    expect(nested.project.id).toBe(projectId);

    const flat = yield* client.createDatabase({ projectId, name: "client-flat" });
    expect(flat.project.id).toBe(projectId);
    expect(flat.isDefault).toBe(false);
    expect(["provisioning", "ready"]).toContain(flat.status);

    const renamed = yield* client.updateDatabase(flat.id, { name: "client-flat-renamed" });
    expect(renamed.name).toBe("client-flat-renamed");
    expect((yield* client.getDatabase(flat.id)).name).toBe("client-flat-renamed");
    expect(
      (yield* client.listProjectDatabases(projectId, { limit: 1 })).map((db) => db.id).sort(),
    ).toEqual([nested.id, flat.id].sort());
    expect((yield* client.listDatabases({ projectId })).map((db) => db.id).sort()).toEqual(
      [nested.id, flat.id].sort(),
    );

    const backups = yield* client.listBackups(nested.id, { limit: 1 });
    expect(Array.isArray(backups.data)).toBe(true);
    expect(backups.meta.backupRetentionDays).toBeGreaterThan(0);
    expect(backups.pagination.hasMore).toBe(false);
    const usage = yield* client.getDatabaseUsage(nested.id, {});
    expect(usage.metrics.operations.unit).toBe("ops");
    expect(usage.metrics.storage.unit).toBe("GiB");
    const restore = yield* apiError(
      client.restoreDatabase(flat.id, {
        source: { type: "backup", databaseId: nested.id, backupId: "bkp_alchemymissing" },
      }),
    );
    expect(isNotFound(restore)).toBe(true);

    const connection = yield* client.createConnection({ databaseId: nested.id, name: "client" });
    expect(connection.database.id).toBe(nested.id);
    const secrets = extractConnectionSecrets(connection);
    expect(secrets.host).toBe(connection.endpoints.direct!.host);
    expect(secrets.user).toBeTruthy();
    expect(secrets.password).toBeDefined();
    const nestedConnection = yield* client.createDatabaseConnection(nested.id, {
      name: "client-nested",
    });
    expect(nestedConnection.name).toBe("client-nested");

    const listed = (yield* client.listDatabaseConnections(nested.id, { limit: 1 })).map(
      (c) => c.id,
    );
    expect(listed).toEqual(expect.arrayContaining([connection.id, nestedConnection.id]));
    expect((yield* client.listConnections({ databaseId: nested.id })).map((c) => c.id)).toEqual(
      expect.arrayContaining([connection.id, nestedConnection.id]),
    );
    expect((yield* client.getConnection(connection.id)).name).toBe("client");

    const rotated = yield* client.rotateConnection(connection.id);
    expect(rotated.id).toBe(connection.id);
    expect(Redacted.value(extractConnectionSecrets(rotated).password!)).not.toBe(
      Redacted.value(secrets.password!),
    );

    yield* client.deleteConnection(connection.id);
    yield* client.deleteConnection(nestedConnection.id);
    yield* expectNotFound(client.getConnection(connection.id));
    yield* expectNotFound(client.getConnection(nestedConnection.id));

    yield* client.deleteDatabase(flat.id);
    yield* client.deleteDatabase(nested.id);
    yield* expectNotFound(client.getDatabase(flat.id));
    expect(isNotFound(yield* apiError(client.deleteDatabase(flat.id)))).toBe(true);

    yield* stack.destroy();
    yield* expectProjectGone(projectId);
  }),
  { tags: tags("database", "connection"), timeout: 240_000 },
);

test.provider(
  "manages buckets, bucket keys, and environment variables",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();
    const client = yield* PrismaClient;
    const { projectId } = yield* stack.deploy(projectStack);

    const bucket = yield* client.createBucket({ projectId, name: "client" });
    expect(bucket.project.id).toBe(projectId);
    expect((yield* client.getBucket(bucket.id)).name).toBe("client");
    expect((yield* client.listBuckets({ projectId })).map((b) => b.id)).toContain(bucket.id);

    const key = yield* client.createBucketKey(bucket.id, { name: "client", role: "read" });
    expect(key.role).toBe("read");
    expect(key.secretAccessKey.length).toBeGreaterThan(0);
    expect(key.bucketName).toBe(bucket.providerName);
    const keys = yield* client.listBucketKeys(bucket.id, { limit: 1 });
    expect(keys.map((k) => k.id)).toEqual([key.id]);
    // The secret is returned once, on create.
    expect("secretAccessKey" in keys[0]!).toBe(false);
    yield* client.deleteBucketKey(bucket.id, key.id);
    expect(yield* client.listBucketKeys(bucket.id)).toEqual([]);
    yield* client.deleteBucket(bucket.id);
    yield* expectNotFound(client.getBucket(bucket.id));

    const variable = yield* client.createEnvironmentVariable({
      projectId,
      class: "preview",
      key: "CLIENT_TEST",
      value: "first",
    });
    expect(variable.projectId).toBe(projectId);
    expect(variable.isManagedBySystem).toBe(false);
    const duplicate = yield* apiError(
      client.createEnvironmentVariable({
        projectId,
        class: "preview",
        key: "CLIENT_TEST",
        value: "second",
      }),
    );
    expect(isConflict(duplicate)).toBe(true);
    const updated = yield* client.updateEnvironmentVariable(variable.id, { value: "second" });
    expect(updated.id).toBe(variable.id);
    expect((yield* client.getEnvironmentVariable(variable.id)).key).toBe("CLIENT_TEST");
    expect(
      (yield* client.listEnvironmentVariables({
        projectId,
        class: "preview",
        key: "CLIENT_TEST",
      })).map((v) => v.id),
    ).toEqual([variable.id]);
    yield* client.deleteEnvironmentVariable(variable.id);
    yield* expectNotFound(client.getEnvironmentVariable(variable.id));

    expect(yield* client.listSourceRepositories({ projectId })).toEqual([]);

    yield* stack.destroy();
    yield* expectProjectGone(projectId);
  }),
  {
    tags: tags("bucket", "bucketaccesskey", "environmentvariable", "sourcerepository"),
    timeout: 180_000,
  },
);

test.provider(
  "creates apps and deployments through the canonical routes",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();
    const client = yield* PrismaClient;
    const { projectId } = yield* stack.deploy(projectStack);

    const app = yield* client.createApp({ projectId, displayName: "client" });
    expect(app.projectId).toBe(projectId);
    expect(app.latestDeploymentId).toBeNull();
    expect(app.appEndpointDomain).toBeTruthy();
    expect((yield* client.getApp(app.id)).name).toBe("client");
    expect((yield* client.updateApp(app.id, { displayName: "client-renamed" })).name).toBe(
      "client-renamed",
    );
    expect((yield* client.listApps({ projectId })).map((a) => a.id)).toEqual([app.id]);
    expect(yield* client.listAppDomains(app.id)).toEqual([]);
    expect(yield* client.listAppDeployments(app.id)).toEqual([]);

    // Prisma refuses a domain until the App has a promoted deployment.
    const domain = yield* apiError(
      client.createAppDomain(app.id, { hostname: "alchemy-prisma-client.example.com" }),
    );
    expect(domain.status).toBe(422);

    const deployment = yield* client.createAppDeployment(app.id, { portMapping: { http: 3000 } });
    expect(deployment.uploadUrl).toMatch(/^https:\/\//);
    const observed = yield* client.getDeployment(deployment.id);
    expect(observed.id).toBe(deployment.id);
    expect(observed.status).toBe("new");
    expect(observed.portMapping).toEqual({ http: 3000 });
    expect((yield* client.listAppDeployments(app.id, { limit: 1 })).map((d) => d.id)).toEqual([
      deployment.id,
    ]);

    const logs = yield* client.getDeploymentLogsRequest(deployment.id, {
      tail: 100,
      fromStart: true,
      cursor: "byte-42",
    });
    expect(logs.url).toBe(
      `wss://api.prisma.io/v1/deployments/${deployment.id}/logs?tail=100&cursor=byte-42&from_start=true`,
    );
    expect(Redacted.value(logs.headers.Authorization)).toMatch(/^Bearer \S+$/);
    const build = yield* client.getBuildLogsRequest("bld_1", { follow: true, cursor: "c-1" });
    expect(build.url).toBe("https://api.prisma.io/v1/builds/bld_1/logs?follow=true&cursor=c-1");
    expect(build.headers.Accept).toBe("application/x-ndjson");

    yield* client.deleteDeployment(deployment.id);
    yield* expectNotFound(client.getDeployment(deployment.id));
    yield* client.deleteApp(app.id);
    yield* expectNotFound(client.getApp(app.id));

    yield* stack.destroy();
    yield* expectProjectGone(projectId);
  }),
  { tags: tags("app", "deployment", "customdomain"), timeout: 180_000 },
);

test.provider(
  "renames a project and refuses a transfer with an invalid recipient token",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();
    const client = yield* PrismaClient;
    const { projectId } = yield* stack.deploy(projectStack);

    const renamed = yield* client.updateProject(projectId, { name: "alchemy-client-renamed" });
    expect(renamed.name).toBe("alchemy-client-renamed");
    expect((yield* client.getProject(projectId)).name).toBe("alchemy-client-renamed");
    expect((yield* client.listProjects({ limit: 10 })).map((p) => p.id)).toContain(projectId);

    const transfer = yield* apiError(
      client.transferProject(projectId, { recipientAccessToken: "not-a-real-token" }),
    );
    expect(transfer.status).toBe(400);
    expect(JSON.stringify(transfer)).not.toContain("not-a-real-token");
    expect((yield* client.getProject(projectId)).id).toBe(projectId);

    yield* stack.destroy();
    yield* expectProjectGone(projectId);
  }),
  { tags: tags(), timeout: 120_000 },
);
