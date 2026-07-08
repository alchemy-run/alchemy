import {
  extractConnectionSecrets,
  PrismaApiError,
  PrismaClient,
  PrismaClientLive,
  type PrismaManagementClient,
} from "@/Prisma/Client";
import { PrismaEnvironment } from "@/Prisma/PrismaEnvironment";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { TestClock } from "effect/testing";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

interface Captured {
  url: string;
  method: string;
  pathname: string;
  search: string;
  authorization: string | undefined;
  bodyJson: unknown;
}

const page = <T>(
  data: T[],
  hasMore = false,
  nextCursor: string | null = null,
) => json({ data, pagination: { hasMore, nextCursor } });

const data = <T>(value: T) => json({ data: value });

const json = (value: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const empty = () => new Response(null, { status: 204 });

const expectedManagementApiRoutes = [
  "GET /v1/apps",
  "POST /v1/apps",
  "GET /v1/apps/{appId}",
  "PATCH /v1/apps/{appId}",
  "DELETE /v1/apps/{appId}",
  "POST /v1/apps/{appId}/promote",
  "POST /v1/apps/{appId}/rollback",
  "GET /v1/apps/{appId}/domains",
  "POST /v1/apps/{appId}/domains",
  "GET /v1/apps/{appId}/deployments",
  "POST /v1/apps/{appId}/deployments",
  "GET /v1/deployments/{deploymentId}",
  "DELETE /v1/deployments/{deploymentId}",
  "POST /v1/deployments/{deploymentId}/start",
  "POST /v1/deployments/{deploymentId}/stop",
  "GET /v1/deployments/{deploymentId}/logs",
  "GET /v1/builds/{buildId}/logs",
  "POST /v1/scm-installations/{installationId}/connect",
  "DELETE /v1/branches/{branchId}",
  "DELETE /v1/compute-services/{computeServiceId}",
  "DELETE /v1/compute-services/versions/{versionId}",
  "DELETE /v1/connections/{id}",
  "DELETE /v1/databases/{databaseId}",
  "DELETE /v1/domains/{domainId}",
  "DELETE /v1/environment-variables/{envVarId}",
  "DELETE /v1/integrations/{id}",
  "DELETE /v1/projects/{id}",
  "DELETE /v1/source-repositories/{id}",
  "DELETE /v1/versions/{versionId}",
  "DELETE /v1/workspaces/{workspaceId}/integrations/{clientId}",
  "GET /v1/branches/{branchId}",
  "GET /v1/compute-services",
  "GET /v1/compute-services/{computeServiceId}",
  "GET /v1/compute-services/{computeServiceId}/domains",
  "GET /v1/compute-services/{computeServiceId}/versions",
  "GET /v1/compute-services/versions/{versionId}",
  "GET /v1/compute-services/versions/{versionId}/logs",
  "GET /v1/connections",
  "GET /v1/connections/{id}",
  "GET /v1/databases",
  "GET /v1/databases/{databaseId}",
  "GET /v1/databases/{databaseId}/backups",
  "GET /v1/databases/{databaseId}/connections",
  "GET /v1/databases/{databaseId}/usage",
  "GET /v1/domains/{domainId}",
  "GET /v1/environment-variables",
  "GET /v1/environment-variables/{envVarId}",
  "GET /v1/integrations",
  "GET /v1/integrations/{id}",
  "GET /v1/me",
  "GET /v1/projects",
  "GET /v1/projects/{id}",
  "GET /v1/projects/{projectId}/branches",
  "GET /v1/projects/{projectId}/compute-services",
  "GET /v1/projects/{projectId}/databases",
  "GET /v1/regions",
  "GET /v1/regions/accelerate",
  "GET /v1/regions/postgres",
  "GET /v1/scm-installations",
  "GET /v1/scm-installations/{installationId}/repositories",
  "GET /v1/source-repositories",
  "GET /v1/source-repositories/{id}",
  "GET /v1/versions",
  "GET /v1/versions/{versionId}",
  "GET /v1/workspaces",
  "GET /v1/workspaces/{id}",
  "GET /v1/workspaces/{workspaceId}/integrations",
  "PATCH /v1/branches/{branchId}",
  "PATCH /v1/compute-services/{computeServiceId}",
  "PATCH /v1/databases/{databaseId}",
  "PATCH /v1/environment-variables/{envVarId}",
  "PATCH /v1/projects/{id}",
  "POST /v1/compute-services",
  "POST /v1/compute-services/{computeServiceId}/domains",
  "POST /v1/compute-services/{computeServiceId}/promote",
  "POST /v1/compute-services/{computeServiceId}/rollback",
  "POST /v1/compute-services/{computeServiceId}/versions",
  "POST /v1/compute-services/versions/{versionId}/start",
  "POST /v1/compute-services/versions/{versionId}/stop",
  "POST /v1/connections",
  "POST /v1/connections/{id}/rotate",
  "POST /v1/databases",
  "POST /v1/databases/{databaseId}/connections",
  "POST /v1/databases/{targetDatabaseId}/restore",
  "POST /v1/domains/{domainId}/retry",
  "POST /v1/environment-variables",
  "POST /v1/projects",
  "POST /v1/projects/{id}/transfer",
  "POST /v1/projects/{projectId}/branches",
  "POST /v1/projects/{projectId}/compute-services",
  "POST /v1/projects/{projectId}/databases",
  "POST /v1/scm-installations/install-intents",
  "POST /v1/source-repositories",
  "POST /v1/versions",
  "POST /v1/versions/{versionId}/start",
  "POST /v1/versions/{versionId}/stop",
].sort();

const concreteRouteTemplates = new Map([
  ["GET /v1/apps", "GET /v1/apps"],
  ["POST /v1/apps", "POST /v1/apps"],
  ["GET /v1/apps/app-1", "GET /v1/apps/{appId}"],
  ["PATCH /v1/apps/app-1", "PATCH /v1/apps/{appId}"],
  ["DELETE /v1/apps/app-1", "DELETE /v1/apps/{appId}"],
  ["POST /v1/apps/app-1/promote", "POST /v1/apps/{appId}/promote"],
  ["POST /v1/apps/app-1/rollback", "POST /v1/apps/{appId}/rollback"],
  ["GET /v1/apps/app-1/domains", "GET /v1/apps/{appId}/domains"],
  ["POST /v1/apps/app-1/domains", "POST /v1/apps/{appId}/domains"],
  ["GET /v1/apps/app-1/deployments", "GET /v1/apps/{appId}/deployments"],
  ["POST /v1/apps/app-1/deployments", "POST /v1/apps/{appId}/deployments"],
  ["GET /v1/deployments/deployment-1", "GET /v1/deployments/{deploymentId}"],
  [
    "DELETE /v1/deployments/deployment-1",
    "DELETE /v1/deployments/{deploymentId}",
  ],
  [
    "POST /v1/deployments/deployment-1/start",
    "POST /v1/deployments/{deploymentId}/start",
  ],
  [
    "POST /v1/deployments/deployment-1/stop",
    "POST /v1/deployments/{deploymentId}/stop",
  ],
  [
    "POST /v1/scm-installations/scminstall-1/connect",
    "POST /v1/scm-installations/{installationId}/connect",
  ],
  ["DELETE /v1/branches/branch-1", "DELETE /v1/branches/{branchId}"],
  [
    "DELETE /v1/compute-services/service-1",
    "DELETE /v1/compute-services/{computeServiceId}",
  ],
  [
    "DELETE /v1/compute-services/versions/version-1",
    "DELETE /v1/compute-services/versions/{versionId}",
  ],
  ["DELETE /v1/connections/connection-1", "DELETE /v1/connections/{id}"],
  ["DELETE /v1/databases/database-1", "DELETE /v1/databases/{databaseId}"],
  ["DELETE /v1/domains/domain-1", "DELETE /v1/domains/{domainId}"],
  [
    "DELETE /v1/environment-variables/env-1",
    "DELETE /v1/environment-variables/{envVarId}",
  ],
  ["DELETE /v1/integrations/integration-1", "DELETE /v1/integrations/{id}"],
  ["DELETE /v1/projects/project-1", "DELETE /v1/projects/{id}"],
  [
    "DELETE /v1/source-repositories/repo-1",
    "DELETE /v1/source-repositories/{id}",
  ],
  ["DELETE /v1/versions/version-1", "DELETE /v1/versions/{versionId}"],
  [
    "DELETE /v1/workspaces/workspace-1/integrations/client-1",
    "DELETE /v1/workspaces/{workspaceId}/integrations/{clientId}",
  ],
  ["GET /v1/branches/branch-1", "GET /v1/branches/{branchId}"],
  ["GET /v1/compute-services", "GET /v1/compute-services"],
  [
    "GET /v1/compute-services/service-1",
    "GET /v1/compute-services/{computeServiceId}",
  ],
  [
    "GET /v1/compute-services/service-1/domains",
    "GET /v1/compute-services/{computeServiceId}/domains",
  ],
  [
    "GET /v1/compute-services/service-1/versions",
    "GET /v1/compute-services/{computeServiceId}/versions",
  ],
  [
    "GET /v1/compute-services/versions/version-1",
    "GET /v1/compute-services/versions/{versionId}",
  ],
  ["GET /v1/connections", "GET /v1/connections"],
  ["GET /v1/connections/connection-1", "GET /v1/connections/{id}"],
  ["GET /v1/databases", "GET /v1/databases"],
  ["GET /v1/databases/database-1", "GET /v1/databases/{databaseId}"],
  [
    "GET /v1/databases/database-1/backups",
    "GET /v1/databases/{databaseId}/backups",
  ],
  [
    "GET /v1/databases/database-1/connections",
    "GET /v1/databases/{databaseId}/connections",
  ],
  [
    "GET /v1/databases/database-1/usage",
    "GET /v1/databases/{databaseId}/usage",
  ],
  ["GET /v1/domains/domain-1", "GET /v1/domains/{domainId}"],
  ["GET /v1/environment-variables", "GET /v1/environment-variables"],
  [
    "GET /v1/environment-variables/env-1",
    "GET /v1/environment-variables/{envVarId}",
  ],
  ["GET /v1/integrations", "GET /v1/integrations"],
  ["GET /v1/integrations/integration-1", "GET /v1/integrations/{id}"],
  ["GET /v1/me", "GET /v1/me"],
  ["GET /v1/projects", "GET /v1/projects"],
  ["GET /v1/projects/project-1", "GET /v1/projects/{id}"],
  [
    "GET /v1/projects/project-1/branches",
    "GET /v1/projects/{projectId}/branches",
  ],
  [
    "GET /v1/projects/project-1/compute-services",
    "GET /v1/projects/{projectId}/compute-services",
  ],
  [
    "GET /v1/projects/project-1/databases",
    "GET /v1/projects/{projectId}/databases",
  ],
  ["GET /v1/regions", "GET /v1/regions"],
  ["GET /v1/regions/accelerate", "GET /v1/regions/accelerate"],
  ["GET /v1/regions/postgres", "GET /v1/regions/postgres"],
  ["GET /v1/scm-installations", "GET /v1/scm-installations"],
  [
    "GET /v1/scm-installations/scminstall-1/repositories",
    "GET /v1/scm-installations/{installationId}/repositories",
  ],
  ["GET /v1/source-repositories", "GET /v1/source-repositories"],
  ["GET /v1/source-repositories/repo-1", "GET /v1/source-repositories/{id}"],
  ["GET /v1/versions", "GET /v1/versions"],
  ["GET /v1/versions/version-1", "GET /v1/versions/{versionId}"],
  ["GET /v1/workspaces", "GET /v1/workspaces"],
  ["GET /v1/workspaces/workspace-1", "GET /v1/workspaces/{id}"],
  [
    "GET /v1/workspaces/workspace-1/integrations",
    "GET /v1/workspaces/{workspaceId}/integrations",
  ],
  ["PATCH /v1/branches/branch-1", "PATCH /v1/branches/{branchId}"],
  [
    "PATCH /v1/compute-services/service-1",
    "PATCH /v1/compute-services/{computeServiceId}",
  ],
  ["PATCH /v1/databases/database-1", "PATCH /v1/databases/{databaseId}"],
  [
    "PATCH /v1/environment-variables/env-1",
    "PATCH /v1/environment-variables/{envVarId}",
  ],
  ["PATCH /v1/projects/project-1", "PATCH /v1/projects/{id}"],
  ["POST /v1/compute-services", "POST /v1/compute-services"],
  [
    "POST /v1/compute-services/service-1/domains",
    "POST /v1/compute-services/{computeServiceId}/domains",
  ],
  [
    "POST /v1/compute-services/service-1/promote",
    "POST /v1/compute-services/{computeServiceId}/promote",
  ],
  [
    "POST /v1/compute-services/service-1/rollback",
    "POST /v1/compute-services/{computeServiceId}/rollback",
  ],
  [
    "POST /v1/compute-services/service-1/versions",
    "POST /v1/compute-services/{computeServiceId}/versions",
  ],
  [
    "POST /v1/compute-services/versions/version-1/start",
    "POST /v1/compute-services/versions/{versionId}/start",
  ],
  [
    "POST /v1/compute-services/versions/version-1/stop",
    "POST /v1/compute-services/versions/{versionId}/stop",
  ],
  ["POST /v1/connections", "POST /v1/connections"],
  [
    "POST /v1/connections/connection-1/rotate",
    "POST /v1/connections/{id}/rotate",
  ],
  ["POST /v1/databases", "POST /v1/databases"],
  [
    "POST /v1/databases/database-1/connections",
    "POST /v1/databases/{databaseId}/connections",
  ],
  [
    "POST /v1/databases/database-1/restore",
    "POST /v1/databases/{targetDatabaseId}/restore",
  ],
  ["POST /v1/domains/domain-1/retry", "POST /v1/domains/{domainId}/retry"],
  ["POST /v1/environment-variables", "POST /v1/environment-variables"],
  ["POST /v1/projects", "POST /v1/projects"],
  ["POST /v1/projects/project-1/transfer", "POST /v1/projects/{id}/transfer"],
  [
    "POST /v1/projects/project-1/branches",
    "POST /v1/projects/{projectId}/branches",
  ],
  [
    "POST /v1/projects/project-1/compute-services",
    "POST /v1/projects/{projectId}/compute-services",
  ],
  [
    "POST /v1/projects/project-1/databases",
    "POST /v1/projects/{projectId}/databases",
  ],
  [
    "POST /v1/scm-installations/install-intents",
    "POST /v1/scm-installations/install-intents",
  ],
  ["POST /v1/source-repositories", "POST /v1/source-repositories"],
  ["POST /v1/versions", "POST /v1/versions"],
  ["POST /v1/versions/version-1/start", "POST /v1/versions/{versionId}/start"],
  ["POST /v1/versions/version-1/stop", "POST /v1/versions/{versionId}/stop"],
]);

const routeInventoryFrom = (captured: Captured[]) => {
  const routes = new Set<string>();
  for (const request of captured) {
    const key = `${request.method} ${request.pathname}`;
    const route = concreteRouteTemplates.get(key);
    if (!route) throw new Error(`Missing route inventory mapping for ${key}`);
    routes.add(route);
  }
  routes.add("GET /v1/compute-services/versions/{versionId}/logs");
  routes.add("GET /v1/deployments/{deploymentId}/logs");
  routes.add("GET /v1/builds/{buildId}/logs");
  return [...routes].sort();
};

const managementApiRoutesFromOpenApiTypes = (source: string) => {
  const routes: string[] = [];
  const methods = ["get", "put", "post", "delete", "patch"] as const;
  const pathMatches = [...source.matchAll(/^\s+"([^"]+)": \{/gm)];
  for (const [index, match] of pathMatches.entries()) {
    const path = match[1];
    const next = pathMatches[index + 1]?.index ?? source.length;
    const body = source.slice(match.index, next);
    for (const method of methods) {
      if (new RegExp(`^\\s+${method}: operations\\[`, "m").test(body)) {
        routes.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return routes.sort();
};

const fixtureResponse = (request: Captured) => {
  if (request.pathname === "/v1/projects" && request.method === "GET") {
    return request.search.includes("cursor=cursor-2")
      ? page([{ id: "project-2", type: "project", name: "Two" }])
      : page(
          [{ id: "project-1", type: "project", name: "One" }],
          true,
          "cursor-2",
        );
  }

  if (
    request.pathname === "/v1/projects/project-1/databases" &&
    request.method === "POST"
  ) {
    return data({ id: "database-1", type: "database", name: "main" });
  }

  if (
    request.pathname === "/v1/projects/project-1/compute-services" &&
    request.method === "POST"
  ) {
    return data({ id: "service-1", type: "compute-service", name: "api" });
  }

  if (
    request.pathname === "/v1/databases/database-1/backups" &&
    request.method === "GET"
  ) {
    return json({
      data: [
        {
          id: "backup-1",
          type: "backup",
          backupType: "full",
          createdAt: "2026-01-01T00:00:00Z",
          status: "completed",
        },
      ],
      meta: {
        backupRetentionDays: 7,
      },
      pagination: {
        hasMore: false,
        limit: 1,
      },
    });
  }

  if (
    request.pathname === "/v1/compute-services/service-1/versions" &&
    request.method === "POST"
  ) {
    return data({
      id: "version-1",
      type: "compute-version",
      foundryVersionId: "foundry-1",
      uploadUrl: "https://upload.example.test/artifact.tar.gz",
    });
  }

  if (
    request.pathname === "/v1/compute-services/versions/version-1" &&
    request.method === "GET"
  ) {
    return data({
      id: "version-1",
      type: "compute-version",
      foundryVersionId: "foundry-1",
      status: "running",
      previewDomain: "version-1.example.test",
      createdAt: "2026-01-01T00:00:00Z",
    });
  }

  if (
    request.pathname === "/v1/compute-services/versions/version-1/start" &&
    request.method === "POST"
  ) {
    return data({ previewDomain: "version-1.example.test" });
  }

  if (
    request.pathname === "/v1/compute-services/versions/version-1/stop" &&
    request.method === "POST"
  ) {
    return empty();
  }

  if (
    request.pathname === "/v1/compute-services/versions/version-1" &&
    request.method === "DELETE"
  ) {
    return empty();
  }

  if (
    request.pathname === "/v1/workspaces/workspace-1/integrations" &&
    request.method === "GET"
  ) {
    return page([{ id: "integration-1", url: "https://example.test" }]);
  }

  if (request.pathname.startsWith("/v1/regions") && request.method === "GET") {
    return json({
      data: [
        {
          id: "us-east-1",
          type: "region",
          name: "US East",
          product: "postgres",
          status: "available",
        },
      ],
    });
  }

  return json(
    {
      error: {
        message: `Unhandled fixture request ${request.method} ${request.pathname}${request.search}`,
      },
    },
    { status: 500 },
  );
};

const harness = (baseUrl = "https://api.prisma.test") => {
  const captured: Captured[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const body = request.body as HttpBody.HttpBody;
      const bodyText =
        body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "";
      const entry: Captured = {
        url: request.url,
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        authorization: request.headers.authorization,
        bodyJson: bodyText ? JSON.parse(bodyText) : undefined,
      };
      captured.push(entry);
      return HttpClientResponse.fromWeb(request, fixtureResponse(entry));
    }),
  );
  const layer = PrismaClientLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, client),
        Layer.succeed(PrismaEnvironment, {
          type: "serviceToken" as const,
          serviceToken: Redacted.make("test-token"),
          source: { type: "env" as const },
          baseUrl,
        }),
      ),
    ),
  );
  return { layer, captured };
};

const withClient = <A>(
  f: (client: PrismaManagementClient) => Effect.Effect<A, any, any>,
) =>
  Effect.gen(function* () {
    const client = yield* PrismaClient;
    return yield* f(client);
  });

const routeCoverageHarness = () => {
  const captured: Captured[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const body = request.body as HttpBody.HttpBody;
      const bodyText =
        body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "";
      const entry: Captured = {
        url: request.url,
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        authorization: request.headers.authorization,
        bodyJson: bodyText ? JSON.parse(bodyText) : undefined,
      };
      captured.push(entry);

      if (entry.pathname.endsWith("/usage")) {
        return HttpClientResponse.fromWeb(
          request,
          json({
            period: { start: "2026-01-01", end: "2026-01-02" },
            metrics: {
              operations: { used: 0, unit: "ops" },
              storage: { used: 0, unit: "GiB" },
            },
            generatedAt: "2026-01-02T00:00:00Z",
          }),
        );
      }

      if (entry.pathname.startsWith("/v1/regions") && entry.method === "GET") {
        return HttpClientResponse.fromWeb(request, json({ data: [] }));
      }

      if (entry.method === "GET") {
        return HttpClientResponse.fromWeb(request, page([]));
      }

      if (
        entry.method === "DELETE" ||
        entry.pathname.endsWith("/stop") ||
        entry.pathname.endsWith("/transfer")
      ) {
        return HttpClientResponse.fromWeb(request, empty());
      }

      return HttpClientResponse.fromWeb(
        request,
        data({
          id: "resource-1",
          type: "resource",
          foundryVersionId: "foundry-1",
          uploadUrl: "https://upload.example.test/artifact.tar.gz",
          previewDomain: "version-1.example.test",
          serviceEndpointDomain: "service-1.example.test",
        }),
      );
    }),
  );
  const layer = PrismaClientLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, client),
        Layer.succeed(PrismaEnvironment, {
          type: "serviceToken" as const,
          serviceToken: Redacted.make("test-token"),
          source: { type: "env" as const },
          baseUrl: "https://api.prisma.test",
        }),
      ),
    ),
  );
  return { layer, captured };
};

describe("PrismaClient", () => {
  it("ignores null connection secret fields", () => {
    const secrets = extractConnectionSecrets({
      id: "connection-1",
      type: "connection",
      url: "https://api.prisma.test/v1/connections/connection-1",
      name: "api",
      createdAt: "2026-01-01T00:00:00Z",
      kind: "postgres",
      connectionString: null,
      endpoints: {
        direct: {
          host: "direct.prisma.test",
          port: 5432,
          connectionString: null,
        },
        pooled: {
          host: "pooled.prisma.test",
          port: 5432,
          connectionString: "postgres://pooled",
        },
      },
      directConnection: {
        host: "legacy.prisma.test",
        pass: null,
        user: "api",
      },
      database: {
        id: "database-1",
        url: "https://api.prisma.test/v1/databases/database-1",
        name: "main",
      },
    } as unknown as Parameters<typeof extractConnectionSecrets>[0]);

    expect(secrets.connectionString).toBeUndefined();
    expect(secrets.directConnectionString).toBeUndefined();
    expect(Redacted.value(secrets.pooledConnectionString!)).toBe(
      "postgres://pooled",
    );
    expect(secrets.host).toBe("legacy.prisma.test");
    expect(secrets.user).toBe("api");
    expect(secrets.password).toBeUndefined();
  });

  it.effect("paginates list endpoints and sends bearer auth", () => {
    const { layer, captured } = harness();

    return withClient((client) =>
      Effect.gen(function* () {
        const projects = yield* client.listProjects({ limit: 1 });

        expect(projects.map((project: { id: string }) => project.id)).toEqual([
          "project-1",
          "project-2",
        ]);
        expect(captured.map((request) => request.pathname)).toEqual([
          "/v1/projects",
          "/v1/projects",
        ]);
        expect(captured[0]?.search).toBe("?limit=1");
        expect(captured[1]?.search).toBe("?limit=1&cursor=cursor-2");
        expect(
          captured.every(
            (request) => request.authorization === "Bearer test-token",
          ),
        ).toBe(true);
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("starts pagination from an explicit cursor", () => {
    const { layer, captured } = harness();

    return withClient((client) =>
      Effect.gen(function* () {
        const projects = yield* client.listProjects({
          limit: 1,
          cursor: "cursor-2",
        });

        expect(projects.map((project: { id: string }) => project.id)).toEqual([
          "project-2",
        ]);
        expect(captured.map((request) => request.pathname)).toEqual([
          "/v1/projects",
        ]);
        expect(captured[0]?.search).toBe("?limit=1&cursor=cursor-2");
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("uses the configured Prisma API base URL", () => {
    const { layer, captured } = harness("https://control-plane.prisma.test");

    return withClient((client) =>
      Effect.gen(function* () {
        yield* client.listProjects({ limit: 1 });

        expect(captured[0]?.url).toBe(
          "https://control-plane.prisma.test/v1/projects?limit=1",
        );
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("uses project-scoped and compute-version management routes", () => {
    const { layer, captured } = harness();

    return withClient((client) =>
      Effect.gen(function* () {
        yield* client.createProjectDatabase("project-1", {
          name: "main",
          region: "us-east-1",
        });
        yield* client.createProjectComputeService("project-1", {
          displayName: "api",
          regionId: "us-east-1",
        });
        yield* client.createServiceComputeVersion("service-1", {
          portMapping: { http: 3000 },
        });
        yield* client.getComputeServiceVersion("version-1");
        yield* client.startComputeServiceVersion("version-1");
        yield* client.stopComputeServiceVersion("version-1");
        yield* client.deleteComputeServiceVersion("version-1");
        yield* client.listWorkspaceIntegrations("workspace-1", { limit: 10 });

        expect(
          captured.map((request) => [
            request.method,
            `${request.pathname}${request.search}`,
          ]),
        ).toEqual([
          ["POST", "/v1/projects/project-1/databases"],
          ["POST", "/v1/projects/project-1/compute-services"],
          ["POST", "/v1/compute-services/service-1/versions"],
          ["GET", "/v1/compute-services/versions/version-1"],
          ["POST", "/v1/compute-services/versions/version-1/start"],
          ["POST", "/v1/compute-services/versions/version-1/stop"],
          ["DELETE", "/v1/compute-services/versions/version-1"],
          ["GET", "/v1/workspaces/workspace-1/integrations?limit=10"],
        ]);
        expect(captured[0]?.bodyJson).toEqual({
          name: "main",
          region: "us-east-1",
        });
        expect(captured[2]?.bodyJson).toEqual({
          portMapping: { http: 3000 },
        });
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("retries transient API failures for destructive requests", () => {
    const captured: Captured[] = [];
    let attempts = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        attempts += 1;
        const url = new URL(request.url);
        captured.push({
          url: request.url,
          method: request.method,
          pathname: url.pathname,
          search: url.search,
          authorization: request.headers.authorization,
          bodyJson: undefined,
        });
        return HttpClientResponse.fromWeb(
          request,
          attempts < 3
            ? json(
                {
                  error: {
                    message: "transient platform failure",
                  },
                },
                { status: 500 },
              )
            : empty(),
        );
      }),
    );
    const layer = PrismaClientLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.succeed(PrismaEnvironment, {
            type: "serviceToken" as const,
            serviceToken: Redacted.make("test-token"),
            source: { type: "env" as const },
            baseUrl: "https://api.prisma.test",
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const fiber = yield* withClient((client) =>
        client.deleteComputeServiceVersion("version-1"),
      ).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);

      expect(attempts).toBe(3);
      expect(captured.map((request) => request.method)).toEqual([
        "DELETE",
        "DELETE",
        "DELETE",
      ]);
      expect(captured.map((request) => request.pathname)).toEqual([
        "/v1/compute-services/versions/version-1",
        "/v1/compute-services/versions/version-1",
        "/v1/compute-services/versions/version-1",
      ]);
    }).pipe(Effect.provide(TestClock.layer()));
  });

  it.effect("retries transient API failures for safe lifecycle posts", () => {
    const captured: Captured[] = [];
    let attempts = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        attempts += 1;
        const url = new URL(request.url);
        captured.push({
          url: request.url,
          method: request.method,
          pathname: url.pathname,
          search: url.search,
          authorization: request.headers.authorization,
          bodyJson: undefined,
        });
        return HttpClientResponse.fromWeb(
          request,
          attempts < 3
            ? json(
                {
                  error: {
                    message: "transient platform failure",
                  },
                },
                { status: 500 },
              )
            : data({
                id: "version-1",
                type: "compute-version",
                url: "https://api.prisma.test/v1/versions/version-1",
                foundryVersionId: "foundry-1",
                status: "running",
                previewDomain: "version-1.prisma.test",
              }),
        );
      }),
    );
    const layer = PrismaClientLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.succeed(PrismaEnvironment, {
            type: "serviceToken" as const,
            serviceToken: Redacted.make("test-token"),
            source: { type: "env" as const },
            baseUrl: "https://api.prisma.test",
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const fiber = yield* withClient((client) =>
        client.startComputeServiceVersion("version-1"),
      ).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 second");
      const version = yield* Fiber.join(fiber);

      expect(attempts).toBe(3);
      expect(version.previewDomain).toBe("version-1.prisma.test");
      expect(captured.map((request) => request.method)).toEqual([
        "POST",
        "POST",
        "POST",
      ]);
      expect(captured.map((request) => request.pathname)).toEqual([
        "/v1/compute-services/versions/version-1/start",
        "/v1/compute-services/versions/version-1/start",
        "/v1/compute-services/versions/version-1/start",
      ]);
    }).pipe(Effect.provide(TestClock.layer()));
  });

  it.effect("does not retry transient API failures for create requests", () => {
    const captured: Captured[] = [];
    let attempts = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        attempts += 1;
        const url = new URL(request.url);
        captured.push({
          url: request.url,
          method: request.method,
          pathname: url.pathname,
          search: url.search,
          authorization: request.headers.authorization,
          bodyJson: undefined,
        });
        return HttpClientResponse.fromWeb(
          request,
          json(
            {
              error: {
                message: "transient platform failure",
              },
            },
            { status: 500 },
          ),
        );
      }),
    );
    const layer = PrismaClientLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.succeed(PrismaEnvironment, {
            type: "serviceToken" as const,
            serviceToken: Redacted.make("test-token"),
            source: { type: "env" as const },
            baseUrl: "https://api.prisma.test",
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const error = yield* withClient((client) =>
        client.createServiceComputeVersion("service-1", {
          portMapping: { http: 3000 },
        }),
      ).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(PrismaApiError);
      expect(attempts).toBe(1);
      expect(captured.map((request) => request.method)).toEqual(["POST"]);
      expect(captured.map((request) => request.pathname)).toEqual([
        "/v1/compute-services/service-1/versions",
      ]);
    });
  });

  it.effect(
    "does not retry transient API failures for transfer requests",
    () => {
      const captured: Captured[] = [];
      let attempts = 0;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          attempts += 1;
          const url = new URL(request.url);
          captured.push({
            url: request.url,
            method: request.method,
            pathname: url.pathname,
            search: url.search,
            authorization: request.headers.authorization,
            bodyJson: undefined,
          });
          return HttpClientResponse.fromWeb(
            request,
            json(
              {
                error: {
                  message: "transient platform failure",
                },
              },
              { status: 500 },
            ),
          );
        }),
      );
      const layer = PrismaClientLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, http),
            Layer.succeed(PrismaEnvironment, {
              type: "serviceToken" as const,
              serviceToken: Redacted.make("test-token"),
              source: { type: "env" as const },
              baseUrl: "https://api.prisma.test",
            }),
          ),
        ),
      );

      return Effect.gen(function* () {
        const error = yield* withClient((client) =>
          client.transferProject("project-1", {
            recipientAccessToken: "recipient-token",
          }),
        ).pipe(Effect.provide(layer), Effect.flip);

        expect(error).toBeInstanceOf(PrismaApiError);
        expect(attempts).toBe(1);
        expect(captured.map((request) => request.method)).toEqual(["POST"]);
        expect(captured.map((request) => request.pathname)).toEqual([
          "/v1/projects/project-1/transfer",
        ]);
      });
    },
  );

  it.effect("retries transient transport failures", () => {
    let attempts = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        attempts += 1;
        return attempts < 3
          ? new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new Error("connection reset"),
                description: "test transport failure",
              }),
            })
          : undefined;
      }).pipe(
        Effect.flatMap((error) =>
          error
            ? Effect.fail(error)
            : Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  page([{ id: "project-1" }]),
                ),
              ),
        ),
      ),
    );
    const layer = PrismaClientLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.succeed(PrismaEnvironment, {
            type: "serviceToken" as const,
            serviceToken: Redacted.make("test-token"),
            source: { type: "env" as const },
            baseUrl: "https://api.prisma.test",
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const fiber = yield* withClient((client) => client.listProjects()).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 second");
      const projects = yield* Fiber.join(fiber);

      expect(attempts).toBe(3);
      expect(projects.map((project) => project.id)).toEqual(["project-1"]);
    }).pipe(Effect.provide(TestClock.layer()));
  });

  it.effect("preserves backup list metadata", () => {
    const { layer, captured } = harness();

    return withClient((client) =>
      Effect.gen(function* () {
        const backups = yield* client.listBackups("database-1", { limit: 1 });

        expect(backups).toEqual({
          data: [
            {
              id: "backup-1",
              type: "backup",
              backupType: "full",
              createdAt: "2026-01-01T00:00:00Z",
              status: "completed",
            },
          ],
          meta: {
            backupRetentionDays: 7,
          },
          pagination: {
            hasMore: false,
            limit: 1,
          },
        });
        expect(captured.map((request) => request.pathname)).toEqual([
          "/v1/databases/database-1/backups",
        ]);
        expect(captured[0]?.search).toBe("?limit=1");
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("reads non-paginated region endpoints", () => {
    const { layer } = harness();

    return withClient((client) =>
      Effect.gen(function* () {
        const regions = yield* client.listRegions({ product: "postgres" });
        const postgresRegions = yield* client.listPostgresRegions();
        const accelerateRegions = yield* client.listAccelerateRegions();

        expect(regions.map((region) => region.id)).toEqual(["us-east-1"]);
        expect(postgresRegions.map((region) => region.id)).toEqual([
          "us-east-1",
        ]);
        expect(accelerateRegions.map((region) => region.id)).toEqual([
          "us-east-1",
        ]);
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("builds authenticated compute log stream requests", () => {
    const { layer, captured } = harness("https://api.prisma.test");

    return withClient((client) =>
      Effect.gen(function* () {
        const request = yield* client.getComputeVersionLogsRequest(
          "version-1",
          {
            tail: 100,
            fromStart: true,
            cursor: "byte-42",
          },
        );
        const url = yield* client.getComputeVersionLogsUrl("version-2", {
          from_start: "false",
        });

        expect(request.url).toBe(
          "wss://api.prisma.test/v1/compute-services/versions/version-1/logs?tail=100&cursor=byte-42&from_start=true",
        );
        expect(Redacted.value(request.headers.Authorization)).toBe(
          "Bearer test-token",
        );
        expect(url).toBe(
          "wss://api.prisma.test/v1/compute-services/versions/version-2/logs?from_start=false",
        );
        expect(captured).toEqual([]);
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect(
    "maps every supported Management API operation to its route",
    () => {
      const { layer, captured } = routeCoverageHarness();

      return withClient((client) =>
        Effect.gen(function* () {
          yield* client.listWorkspaces({ limit: 1 });
          yield* client.getWorkspace("workspace-1");
          yield* client.getCurrentPrincipal();
          yield* client.listRegions({ product: "postgres" });
          yield* client.listPostgresRegions();
          yield* client.listAccelerateRegions();

          yield* client.listProjects({ limit: 1 });
          yield* client.getProject("project-1");
          yield* client.createProject({ name: "app", region: "us-east-1" });
          yield* client.updateProject("project-1", { name: "renamed" });
          yield* client.deleteProject("project-1");
          yield* client.transferProject("project-1", {
            recipientAccessToken: "recipient-token",
          });

          yield* client.listDatabases({
            projectId: "project-1",
            branchGitName: "main",
          });
          yield* client.listProjectDatabases("project-1", { limit: 1 });
          yield* client.getDatabase("database-1");
          yield* client.createDatabase({
            projectId: "project-1",
            name: "main",
          });
          yield* client.createProjectDatabase("project-1", {
            name: "main",
            fromDatabase: {
              id: "database-source",
              backupId: "backup-1",
            },
          });
          yield* client.updateDatabase("database-1", { name: "main-2" });
          yield* client.deleteDatabase("database-1");
          yield* client.listBackups("database-1", { limit: 1 });
          yield* client.restoreDatabase("database-1", {
            source: {
              type: "backup",
              databaseId: "database-source",
              backupId: "backup-1",
            },
          });
          yield* client.getDatabaseUsage("database-1", {
            startDate: "2026-01-01",
          });

          yield* client.listConnections({ databaseId: "database-1" });
          yield* client.listDatabaseConnections("database-1", { limit: 1 });
          yield* client.getConnection("connection-1");
          yield* client.createConnection({
            databaseId: "database-1",
            name: "direct",
          });
          yield* client.createDatabaseConnection("database-1", {
            name: "direct",
          });
          yield* client.deleteConnection("connection-1");
          yield* client.rotateConnection("connection-1");

          yield* client.listBranches("project-1", { gitName: "main" });
          yield* client.getBranch("branch-1");
          yield* client.createBranch("project-1", { gitName: "main" });
          yield* client.updateBranch("branch-1", { isDefault: true });
          yield* client.deleteBranch("branch-1");

          yield* client.listComputeServices({
            projectId: "project-1",
            branchGitName: "main",
          });
          yield* client.listProjectComputeServices("project-1", { limit: 1 });
          yield* client.getComputeService("service-1");
          yield* client.createComputeService({
            projectId: "project-1",
            displayName: "api",
          });
          yield* client.createProjectComputeService("project-1", {
            displayName: "api",
          });
          yield* client.updateComputeService("service-1", {
            displayName: "api-2",
          });
          yield* client.deleteComputeService("service-1");
          yield* client.promoteComputeService("service-1", "version-1");
          yield* client.rollbackComputeService("service-1", "version-1");
          yield* client.listComputeServiceDomains("service-1");
          yield* client.createComputeServiceDomain("service-1", {
            hostname: "api.example.com",
          });
          yield* client.getCustomDomain("domain-1");
          yield* client.deleteCustomDomain("domain-1");
          yield* client.retryCustomDomain("domain-1");

          yield* client.listComputeVersions({ computeServiceId: "service-1" });
          yield* client.listServiceComputeVersions("service-1", { limit: 1 });
          yield* client.getComputeVersion("version-1");
          yield* client.getComputeServiceVersion("version-1");
          yield* client.createComputeVersion({
            computeServiceId: "service-1",
            portMapping: { http: 3000 },
          });
          yield* client.createServiceComputeVersion("service-1", {
            skipCodeUpload: true,
          });
          yield* client.deleteComputeVersion("version-1");
          yield* client.deleteComputeServiceVersion("version-1");
          yield* client.startComputeVersion("version-1");
          yield* client.startComputeServiceVersion("version-1");
          yield* client.stopComputeVersion("version-1");
          yield* client.stopComputeServiceVersion("version-1");

          yield* client.listEnvironmentVariables({
            projectId: "project-1",
            class: "production",
            key: "TOKEN",
          });
          yield* client.getEnvironmentVariable("env-1");
          yield* client.createEnvironmentVariable({
            projectId: "project-1",
            class: "production",
            key: "TOKEN",
            value: "secret",
          });
          yield* client.updateEnvironmentVariable("env-1", {
            value: "secret-2",
          });
          yield* client.deleteEnvironmentVariable("env-1");

          yield* client.listIntegrations({ workspaceId: "workspace-1" });
          yield* client.listWorkspaceIntegrations("workspace-1", { limit: 1 });
          yield* client.getIntegration("integration-1");
          yield* client.deleteIntegration("integration-1");
          yield* client.revokeWorkspaceIntegration("workspace-1", "client-1");

          yield* client.listScmInstallations({ workspaceId: "workspace-1" });
          yield* client.createScmInstallIntent({
            provider: "github",
            workspaceId: "workspace-1",
          });
          yield* client.listScmInstallationRepositories("scminstall-1", {
            limit: 10,
          });

          yield* client.listSourceRepositories({ projectId: "project-1" });
          yield* client.getSourceRepository("repo-1");
          yield* client.createSourceRepository({
            projectId: "project-1",
            provider: "github",
            providerRepositoryId: 123,
            installationId: "scminstall-1",
          });
          yield* client.deleteSourceRepository("repo-1");

          yield* client.listApps({
            projectId: "project-1",
            branchGitName: "main",
          });
          yield* client.getApp("app-1");
          yield* client.createApp({
            projectId: "project-1",
            displayName: "web",
          });
          yield* client.updateApp("app-1", { displayName: "web-2" });
          yield* client.deleteApp("app-1");
          yield* client.promoteApp("app-1", { deploymentId: "deployment-1" });
          yield* client.rollbackApp("app-1", { deploymentId: "deployment-1" });
          yield* client.listAppDomains("app-1");
          yield* client.createAppDomain("app-1", {
            hostname: "web.example.com",
          });
          yield* client.listAppDeployments("app-1", { limit: 1 });
          yield* client.createAppDeployment("app-1", {
            skipCodeUpload: true,
          });
          yield* client.getDeployment("deployment-1");
          yield* client.deleteDeployment("deployment-1");
          yield* client.startDeployment("deployment-1");
          yield* client.stopDeployment("deployment-1");
          yield* client.connectScmInstallation("scminstall-1", {
            workspaceId: "workspace-1",
          });

          const deploymentLogsUrl = yield* client.getDeploymentLogsUrl(
            "deployment-1",
            { tail: 10 },
          );
          expect(deploymentLogsUrl).toBe(
            "wss://api.prisma.test/v1/deployments/deployment-1/logs?tail=10",
          );
          const buildLogsUrl = yield* client.getBuildLogsUrl("build-1");
          expect(buildLogsUrl).toBe(
            "wss://api.prisma.test/v1/builds/build-1/logs",
          );

          expect(
            captured.map((request) => [
              request.method,
              `${request.pathname}${request.search}`,
            ]),
          ).toEqual([
            ["GET", "/v1/workspaces?limit=1"],
            ["GET", "/v1/workspaces/workspace-1"],
            ["GET", "/v1/me"],
            ["GET", "/v1/regions?product=postgres"],
            ["GET", "/v1/regions/postgres"],
            ["GET", "/v1/regions/accelerate"],
            ["GET", "/v1/projects?limit=1"],
            ["GET", "/v1/projects/project-1"],
            ["POST", "/v1/projects"],
            ["PATCH", "/v1/projects/project-1"],
            ["DELETE", "/v1/projects/project-1"],
            ["POST", "/v1/projects/project-1/transfer"],
            ["GET", "/v1/databases?projectId=project-1&branchGitName=main"],
            ["GET", "/v1/projects/project-1/databases?limit=1"],
            ["GET", "/v1/databases/database-1"],
            ["POST", "/v1/databases"],
            ["POST", "/v1/projects/project-1/databases"],
            ["PATCH", "/v1/databases/database-1"],
            ["DELETE", "/v1/databases/database-1"],
            ["GET", "/v1/databases/database-1/backups?limit=1"],
            ["POST", "/v1/databases/database-1/restore"],
            ["GET", "/v1/databases/database-1/usage?startDate=2026-01-01"],
            ["GET", "/v1/connections?databaseId=database-1"],
            ["GET", "/v1/databases/database-1/connections?limit=1"],
            ["GET", "/v1/connections/connection-1"],
            ["POST", "/v1/connections"],
            ["POST", "/v1/databases/database-1/connections"],
            ["DELETE", "/v1/connections/connection-1"],
            ["POST", "/v1/connections/connection-1/rotate"],
            ["GET", "/v1/projects/project-1/branches?gitName=main"],
            ["GET", "/v1/branches/branch-1"],
            ["POST", "/v1/projects/project-1/branches"],
            ["PATCH", "/v1/branches/branch-1"],
            ["DELETE", "/v1/branches/branch-1"],
            [
              "GET",
              "/v1/compute-services?projectId=project-1&branchGitName=main",
            ],
            ["GET", "/v1/projects/project-1/compute-services?limit=1"],
            ["GET", "/v1/compute-services/service-1"],
            ["POST", "/v1/compute-services"],
            ["POST", "/v1/projects/project-1/compute-services"],
            ["PATCH", "/v1/compute-services/service-1"],
            ["DELETE", "/v1/compute-services/service-1"],
            ["POST", "/v1/compute-services/service-1/promote"],
            ["POST", "/v1/compute-services/service-1/rollback"],
            ["GET", "/v1/compute-services/service-1/domains"],
            ["POST", "/v1/compute-services/service-1/domains"],
            ["GET", "/v1/domains/domain-1"],
            ["DELETE", "/v1/domains/domain-1"],
            ["POST", "/v1/domains/domain-1/retry"],
            ["GET", "/v1/versions?computeServiceId=service-1"],
            ["GET", "/v1/compute-services/service-1/versions?limit=1"],
            ["GET", "/v1/versions/version-1"],
            ["GET", "/v1/compute-services/versions/version-1"],
            ["POST", "/v1/versions"],
            ["POST", "/v1/compute-services/service-1/versions"],
            ["DELETE", "/v1/versions/version-1"],
            ["DELETE", "/v1/compute-services/versions/version-1"],
            ["POST", "/v1/versions/version-1/start"],
            ["POST", "/v1/compute-services/versions/version-1/start"],
            ["POST", "/v1/versions/version-1/stop"],
            ["POST", "/v1/compute-services/versions/version-1/stop"],
            [
              "GET",
              "/v1/environment-variables?projectId=project-1&class=production&key=TOKEN",
            ],
            ["GET", "/v1/environment-variables/env-1"],
            ["POST", "/v1/environment-variables"],
            ["PATCH", "/v1/environment-variables/env-1"],
            ["DELETE", "/v1/environment-variables/env-1"],
            ["GET", "/v1/integrations?workspaceId=workspace-1"],
            ["GET", "/v1/workspaces/workspace-1/integrations?limit=1"],
            ["GET", "/v1/integrations/integration-1"],
            ["DELETE", "/v1/integrations/integration-1"],
            ["DELETE", "/v1/workspaces/workspace-1/integrations/client-1"],
            ["GET", "/v1/scm-installations?workspaceId=workspace-1"],
            ["POST", "/v1/scm-installations/install-intents"],
            ["GET", "/v1/scm-installations/scminstall-1/repositories?limit=10"],
            ["GET", "/v1/source-repositories?projectId=project-1"],
            ["GET", "/v1/source-repositories/repo-1"],
            ["POST", "/v1/source-repositories"],
            ["DELETE", "/v1/source-repositories/repo-1"],
            ["GET", "/v1/apps?projectId=project-1&branchGitName=main"],
            ["GET", "/v1/apps/app-1"],
            ["POST", "/v1/apps"],
            ["PATCH", "/v1/apps/app-1"],
            ["DELETE", "/v1/apps/app-1"],
            ["POST", "/v1/apps/app-1/promote"],
            ["POST", "/v1/apps/app-1/rollback"],
            ["GET", "/v1/apps/app-1/domains"],
            ["POST", "/v1/apps/app-1/domains"],
            ["GET", "/v1/apps/app-1/deployments?limit=1"],
            ["POST", "/v1/apps/app-1/deployments"],
            ["GET", "/v1/deployments/deployment-1"],
            ["DELETE", "/v1/deployments/deployment-1"],
            ["POST", "/v1/deployments/deployment-1/start"],
            ["POST", "/v1/deployments/deployment-1/stop"],
            ["POST", "/v1/scm-installations/scminstall-1/connect"],
          ]);
          expect(routeInventoryFrom(captured)).toEqual(
            expectedManagementApiRoutes,
          );
          expect(expectedManagementApiRoutes).toHaveLength(96);
          expect(captured[11]?.bodyJson).toEqual({
            recipientAccessToken: "recipient-token",
          });
          const restoreRequest = captured.find(
            (request) =>
              request.method === "POST" &&
              request.pathname === "/v1/databases/database-1/restore",
          );
          expect(restoreRequest?.bodyJson).toEqual({
            source: {
              type: "backup",
              databaseId: "database-source",
              backupId: "backup-1",
            },
          });
          const projectDatabaseRequest = captured.find(
            (request) =>
              request.method === "POST" &&
              request.pathname === "/v1/projects/project-1/databases",
          );
          expect(projectDatabaseRequest?.bodyJson).toEqual({
            name: "main",
            fromDatabase: {
              id: "database-source",
              backupId: "backup-1",
            },
          });

          const createComputeServiceRequest = captured.find(
            (request) =>
              request.method === "POST" &&
              request.pathname === "/v1/compute-services",
          );
          expect(createComputeServiceRequest?.bodyJson).toEqual({
            projectId: "project-1",
            displayName: "api",
          });

          const createProjectComputeServiceRequest = captured.find(
            (request) =>
              request.method === "POST" &&
              request.pathname === "/v1/projects/project-1/compute-services",
          );
          expect(createProjectComputeServiceRequest?.bodyJson).toEqual({
            displayName: "api",
          });

          const promoteRequest = captured.find(
            (request) =>
              request.method === "POST" &&
              request.pathname === "/v1/compute-services/service-1/promote",
          );
          expect(promoteRequest?.bodyJson).toEqual({
            versionId: "version-1",
          });

          const rollbackRequest = captured.find(
            (request) =>
              request.method === "POST" &&
              request.pathname === "/v1/compute-services/service-1/rollback",
          );
          expect(rollbackRequest?.bodyJson).toEqual({
            versionId: "version-1",
          });

          const createDomainRequest = captured.find(
            (request) =>
              request.method === "POST" &&
              request.pathname === "/v1/compute-services/service-1/domains",
          );
          expect(createDomainRequest?.bodyJson).toEqual({
            hostname: "api.example.com",
          });

          const createVersionRequest = captured.find(
            (request) =>
              request.method === "POST" && request.pathname === "/v1/versions",
          );
          expect(createVersionRequest?.bodyJson).toEqual({
            computeServiceId: "service-1",
            portMapping: { http: 3000 },
          });

          const createServiceVersionRequest = captured.find(
            (request) =>
              request.method === "POST" &&
              request.pathname === "/v1/compute-services/service-1/versions",
          );
          expect(createServiceVersionRequest?.bodyJson).toEqual({
            skipCodeUpload: true,
          });

          const createEnvRequest = captured.find(
            (request) =>
              request.method === "POST" &&
              request.pathname === "/v1/environment-variables",
          );
          expect(createEnvRequest?.bodyJson).toEqual({
            projectId: "project-1",
            class: "production",
            key: "TOKEN",
            value: "secret",
          });

          const updateEnvRequest = captured.find(
            (request) =>
              request.method === "PATCH" &&
              request.pathname === "/v1/environment-variables/env-1",
          );
          expect(updateEnvRequest?.bodyJson).toEqual({
            value: "secret-2",
          });

          const sourceRepositoryRequest = captured.find(
            (request) =>
              request.method === "POST" &&
              request.pathname === "/v1/source-repositories",
          );
          expect(sourceRepositoryRequest?.bodyJson).toEqual({
            projectId: "project-1",
            provider: "github",
            providerRepositoryId: 123,
            installationId: "scminstall-1",
          });

          const installIntentRequest = captured.find(
            (request) =>
              request.method === "POST" &&
              request.pathname === "/v1/scm-installations/install-intents",
          );
          expect(installIntentRequest?.bodyJson).toEqual({
            provider: "github",
            workspaceId: "workspace-1",
          });
        }),
      ).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "matches the cloned Management API SDK route inventory when present",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const referenceApiPath = path.resolve(
          import.meta.dirname,
          "../../../../pdp-control-plane/packages/management-api-sdk/src/api.d.ts",
        );

        if (!(yield* fs.exists(referenceApiPath))) return;

        const source = yield* fs.readFileString(referenceApiPath);
        // The SDK's api.d.ts is generated from the production OpenAPI doc
        // (`https://api.prisma.io/v1/doc`), so routes that exist in the
        // control-plane sources but have not shipped yet are absent from it.
        const unreleasedRoutes = new Set([
          "POST /v1/scm-installations/{installationId}/connect",
        ]);
        expect(managementApiRoutesFromOpenApiTypes(source)).toEqual(
          expectedManagementApiRoutes.filter(
            (route) => !unreleasedRoutes.has(route),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
