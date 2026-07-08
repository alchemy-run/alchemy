import * as Prisma from "@/Prisma";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const lifecycleResources = [
  {
    name: "Project",
    resource: Prisma.Project,
    routes: [
      "GET /v1/projects",
      "POST /v1/projects",
      "GET /v1/projects/{id}",
      "PATCH /v1/projects/{id}",
      "DELETE /v1/projects/{id}",
    ],
  },
  {
    name: "Database",
    resource: Prisma.Database,
    routes: [
      "GET /v1/databases",
      "POST /v1/databases",
      "GET /v1/projects/{projectId}/databases",
      "POST /v1/projects/{projectId}/databases",
      "GET /v1/databases/{databaseId}",
      "PATCH /v1/databases/{databaseId}",
      "DELETE /v1/databases/{databaseId}",
    ],
  },
  {
    name: "Connection",
    resource: Prisma.Connection,
    routes: [
      "GET /v1/connections",
      "POST /v1/connections",
      "GET /v1/databases/{databaseId}/connections",
      "POST /v1/databases/{databaseId}/connections",
      "GET /v1/connections/{id}",
      "DELETE /v1/connections/{id}",
    ],
  },
  {
    name: "Branch",
    resource: Prisma.Branch,
    routes: [
      "GET /v1/projects/{projectId}/branches",
      "POST /v1/projects/{projectId}/branches",
      "GET /v1/branches/{branchId}",
      "PATCH /v1/branches/{branchId}",
      "DELETE /v1/branches/{branchId}",
    ],
  },
  {
    name: "ComputeService",
    resource: Prisma.ComputeService,
    routes: [
      "GET /v1/compute-services",
      "POST /v1/compute-services",
      "GET /v1/projects/{projectId}/compute-services",
      "POST /v1/projects/{projectId}/compute-services",
      "GET /v1/compute-services/{computeServiceId}",
      "PATCH /v1/compute-services/{computeServiceId}",
      "DELETE /v1/compute-services/{computeServiceId}",
    ],
  },
  {
    name: "ComputeVersion",
    resource: Prisma.ComputeVersion,
    routes: [
      "GET /v1/versions",
      "POST /v1/versions",
      "GET /v1/versions/{versionId}",
      "DELETE /v1/versions/{versionId}",
      "GET /v1/compute-services/{computeServiceId}/versions",
      "POST /v1/compute-services/{computeServiceId}/versions",
      "GET /v1/compute-services/versions/{versionId}",
      "DELETE /v1/compute-services/versions/{versionId}",
    ],
  },
  {
    name: "CustomDomain",
    resource: Prisma.CustomDomain,
    routes: [
      "GET /v1/compute-services/{computeServiceId}/domains",
      "POST /v1/compute-services/{computeServiceId}/domains",
      "GET /v1/domains/{domainId}",
      "DELETE /v1/domains/{domainId}",
    ],
  },
  {
    name: "EnvironmentVariable",
    resource: Prisma.EnvironmentVariable,
    routes: [
      "GET /v1/environment-variables",
      "POST /v1/environment-variables",
      "GET /v1/environment-variables/{envVarId}",
      "PATCH /v1/environment-variables/{envVarId}",
      "DELETE /v1/environment-variables/{envVarId}",
    ],
  },
  {
    name: "SourceRepository",
    resource: Prisma.SourceRepository,
    routes: [
      "GET /v1/source-repositories",
      "POST /v1/source-repositories",
      "GET /v1/source-repositories/{id}",
      "DELETE /v1/source-repositories/{id}",
    ],
  },
] as const;

const operationOnlyRoutes = [
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
  "POST /v1/projects/{id}/transfer",
  "GET /v1/databases/{databaseId}/backups",
  "POST /v1/databases/{targetDatabaseId}/restore",
  "GET /v1/databases/{databaseId}/usage",
  "POST /v1/connections/{id}/rotate",
  "POST /v1/compute-services/{computeServiceId}/promote",
  "POST /v1/compute-services/{computeServiceId}/rollback",
  "POST /v1/versions/{versionId}/start",
  "POST /v1/versions/{versionId}/stop",
  "POST /v1/compute-services/versions/{versionId}/start",
  "POST /v1/compute-services/versions/{versionId}/stop",
  "GET /v1/compute-services/versions/{versionId}/logs",
  "POST /v1/domains/{domainId}/retry",
  "GET /v1/me",
  "GET /v1/workspaces",
  "GET /v1/workspaces/{id}",
  "GET /v1/regions",
  "GET /v1/regions/postgres",
  "GET /v1/regions/accelerate",
  "GET /v1/scm-installations",
  "POST /v1/scm-installations/install-intents",
  "GET /v1/scm-installations/{installationId}/repositories",
  "GET /v1/integrations",
  "GET /v1/integrations/{id}",
  "DELETE /v1/integrations/{id}",
  "GET /v1/workspaces/{workspaceId}/integrations",
  "DELETE /v1/workspaces/{workspaceId}/integrations/{clientId}",
] as const;

const expectedManagementApiRoutes = [
  ...lifecycleResources.flatMap((resource) => resource.routes),
  ...operationOnlyRoutes,
].sort();

/**
 * Routes that exist in the control-plane route sources but have not shipped
 * to the production OpenAPI document yet (the SDK's `api.d.ts` is generated
 * from `https://api.prisma.io/v1/doc`). Remove entries as they go live.
 */
const unreleasedManagementApiRoutes = new Set<string>([
  "POST /v1/scm-installations/{installationId}/connect",
]);

const releasedManagementApiRoutes = expectedManagementApiRoutes.filter(
  (route) => !unreleasedManagementApiRoutes.has(route),
);

const expectedProjectComputeSdkRoutes = [
  "DELETE /v1/compute-services/{computeServiceId}",
  "DELETE /v1/compute-services/versions/{versionId}",
  "DELETE /v1/environment-variables/{envVarId}",
  "GET /v1/branches/{branchId}",
  "GET /v1/compute-services/{computeServiceId}",
  "GET /v1/compute-services/{computeServiceId}/versions",
  "GET /v1/compute-services/versions/{versionId}",
  "GET /v1/environment-variables",
  "GET /v1/projects",
  "GET /v1/projects/{id}",
  "GET /v1/projects/{projectId}/compute-services",
  "PATCH /v1/environment-variables/{envVarId}",
  "POST /v1/compute-services/{computeServiceId}/promote",
  "POST /v1/compute-services/{computeServiceId}/versions",
  "POST /v1/compute-services/versions/{versionId}/start",
  "POST /v1/compute-services/versions/{versionId}/stop",
  "POST /v1/environment-variables",
  "POST /v1/projects",
  "POST /v1/projects/{projectId}/compute-services",
].sort();

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

const joinRoutePath = (basePath: string, routePath: string) => {
  const joined =
    routePath === "/"
      ? basePath || "/"
      : `${basePath.replace(/\/$/, "")}/${routePath.replace(/^\//, "")}`;
  return `/v1${joined === "/" ? "" : joined}`.replace(
    /:([A-Za-z][A-Za-z0-9_]*)/g,
    "{$1}",
  );
};

const mountedRouteFilesFromV1Router = (
  source: string,
  routesRoot: string,
  path: Path.Path,
) => {
  const imports = new Map<string, string>();
  for (const match of source.matchAll(
    /import\s+\{\s*router\s+as\s+([A-Za-z0-9_]+)\s*\}\s+from\s+"\.\/v1\/([^"]+)";/g,
  )) {
    imports.set(match[1], path.join(routesRoot, "v1", `${match[2]}.ts`));
  }

  const mountedFiles: string[] = [];
  for (const match of source.matchAll(
    /router\.route\(\s*`\/`\s*,\s*([A-Za-z0-9_]+)\s*\)/g,
  )) {
    const file = imports.get(match[1]);
    if (file) mountedFiles.push(file);
  }
  return mountedFiles.sort();
};

const managementApiRoutesFromRouteSource = (
  source: string,
  routeFile: string,
) => {
  const baseMatch = source.match(/basePath\(\s*`([^`]+)`\s*,?\s*\)/);
  const basePath = baseMatch?.[1] ?? "";
  const routes: string[] = [];

  for (const match of source.matchAll(
    /router\.(get|put|post|delete|patch)\(\s*`([^`]+)`/g,
  )) {
    const method = match[1].toUpperCase();
    routes.push(`${method} ${joinRoutePath(basePath, match[2])}`);
  }

  if (routes.length === 0) {
    throw new Error(`No Management API routes parsed from ${routeFile}`);
  }

  return routes;
};

const adminRoutesFromSource = (source: string) =>
  Array.from(
    source.matchAll(
      /router\.(all|get|put|post|delete|patch)\(\s*([`"])([^`"]+)\2/g,
    ),
    (match) => `${match[1].toUpperCase()} /__admin${match[3]}`,
  ).sort();

const projectComputeSdkRoutesFromSource = (source: string) =>
  Array.from(
    source.matchAll(/this\.#client\.(GET|POST|PATCH|DELETE|PUT)\("([^"]+)"/g),
    (match) => `${match[1]} ${match[2]}`,
  ).sort();

describe("Prisma Management API coverage", () => {
  it("maps lifecycle route groups to Alchemy resources", () => {
    for (const { name, resource } of lifecycleResources) {
      expect(resource.Type).toBe(`Prisma.${name}`);
    }
  });

  it.effect("accounts for every current Management API route", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const referenceApiPath = path.resolve(
        import.meta.dirname,
        "../../../../pdp-control-plane/packages/management-api-sdk/src/api.d.ts",
      );

      if (!(yield* fs.exists(referenceApiPath))) return;

      const source = yield* fs.readFileString(referenceApiPath);
      expect(expectedManagementApiRoutes).toHaveLength(96);
      expect(managementApiRoutesFromOpenApiTypes(source)).toEqual(
        releasedManagementApiRoutes,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("matches the mounted control-plane route source inventory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const routesRoot = path.resolve(
        import.meta.dirname,
        "../../../../pdp-control-plane/services/management-api/routes",
      );
      const v1RouterPath = path.join(routesRoot, "v1.ts");

      if (!(yield* fs.exists(v1RouterPath))) return;

      const v1RouterSource = yield* fs.readFileString(v1RouterPath);
      const mountedFiles = mountedRouteFilesFromV1Router(
        v1RouterSource,
        routesRoot,
        path,
      );
      const routes: string[] = [];
      for (const routeFile of mountedFiles) {
        const source = yield* fs.readFileString(routeFile);
        routes.push(...managementApiRoutesFromRouteSource(source, routeFile));
      }

      expect([...new Set(routes)].sort()).toEqual(expectedManagementApiRoutes);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps internal admin routes outside the public Prisma surface",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const adminRoutePath = path.resolve(
          import.meta.dirname,
          "../../../../pdp-control-plane/services/management-api/routes/admin.ts",
        );
        const referenceApiPath = path.resolve(
          import.meta.dirname,
          "../../../../pdp-control-plane/packages/management-api-sdk/src/api.d.ts",
        );

        if (
          !(yield* fs.exists(adminRoutePath)) ||
          !(yield* fs.exists(referenceApiPath))
        ) {
          return;
        }

        const adminSource = yield* fs.readFileString(adminRoutePath);
        const publicSdkSource = yield* fs.readFileString(referenceApiPath);
        expect(adminSource).toContain("adminAuthentication()");
        expect(adminRoutesFromSource(adminSource)).toEqual([
          "ALL /__admin/whoami",
          "DELETE /__admin/users/:userId",
          "DELETE /__admin/workspaces/:workspaceId/hold",
          "DELETE /__admin/workspaces/:workspaceId/subscription",
          "GET /__admin/doc",
          "GET /__admin/swagger-editor",
          "GET /__admin/workspaces/:workspaceId/subscription",
          "POST /__admin/workspaces/:workspaceId/hold",
          "POST /__admin/workspaces/:workspaceId/qe-response-override-reset",
          "POST /__admin/workspaces/:workspaceId/subscription",
        ]);
        expect(publicSdkSource).not.toContain("/__admin");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("covers the current project-compute SDK route subset", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sdkClientPath = path.resolve(
        import.meta.dirname,
        "../../../../project-compute/sdk/src/api-client.ts",
      );

      if (!(yield* fs.exists(sdkClientPath))) return;

      const sdkSource = yield* fs.readFileString(sdkClientPath);
      const sdkRoutes = projectComputeSdkRoutesFromSource(sdkSource);
      const publicRoutes = new Set<string>(expectedManagementApiRoutes);
      expect(sdkRoutes).toEqual(expectedProjectComputeSdkRoutes);
      expect(sdkRoutes.every((route) => publicRoutes.has(route))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
