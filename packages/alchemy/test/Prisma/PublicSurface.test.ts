import * as Prisma from "@/Prisma";
import * as PrismaPackage from "alchemy/Prisma";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const publicExports = [
  "providers",
  "managementApi",
  "Providers",
  "PrismaEnvironment",
  "PrismaAuth",
  "PrismaClient",
  "Project",
  "ProjectProvider",
  "Database",
  "DatabaseProvider",
  "Postgres",
  "Connection",
  "ConnectionBinding",
  "ConnectionBindingLive",
  "ConnectionBindingPolicy",
  "ConnectionBindingPolicyLive",
  "ConnectionProvider",
  "connectionBindingEnvKeys",
  "Branch",
  "BranchProvider",
  "ComputeService",
  "ComputeServiceProvider",
  "ComputeVersion",
  "ComputeVersionProvider",
  "EnvironmentVariable",
  "EnvironmentVariableProvider",
  "SourceRepository",
  "SourceRepositoryProvider",
  "Compute",
  "ComputeProvider",
  "ComputeDevProvider",
  "isCompute",
  "KNOWN_REGION_IDS",
  "REGIONS",
  "PRISMA_API_TOKEN_ENV",
  "PRISMA_SERVICE_TOKEN_ENV",
  "PRISMA_AUTH_PROVIDER_NAME",
  "PrismaApiDecodeError",
  "PrismaApiError",
  "PrismaClientLive",
  "PrismaLogStreamError",
  "listWorkspaces",
  "getWorkspace",
  "listRegions",
  "listPostgresRegions",
  "listAccelerateRegions",
  "listProjects",
  "getProject",
  "createProject",
  "updateProject",
  "deleteProject",
  "transferProject",
  "listDatabases",
  "listProjectDatabases",
  "getDatabase",
  "createDatabase",
  "createProjectDatabase",
  "updateDatabase",
  "deleteDatabase",
  "listBackups",
  "restoreDatabase",
  "getDatabaseUsage",
  "listConnections",
  "listDatabaseConnections",
  "getConnection",
  "createConnection",
  "createDatabaseConnection",
  "deleteConnection",
  "rotateConnection",
  "listBranches",
  "getBranch",
  "createBranch",
  "updateBranch",
  "deleteBranch",
  "listComputeServices",
  "listProjectComputeServices",
  "getComputeService",
  "createComputeService",
  "createProjectComputeService",
  "updateComputeService",
  "deleteComputeService",
  "promoteComputeService",
  "listComputeVersions",
  "listServiceComputeVersions",
  "getComputeVersion",
  "getComputeServiceVersion",
  "createComputeVersion",
  "createServiceComputeVersion",
  "deleteComputeVersion",
  "deleteComputeServiceVersion",
  "startComputeVersion",
  "startComputeServiceVersion",
  "stopComputeVersion",
  "stopComputeServiceVersion",
  "getComputeVersionLogsRequest",
  "getComputeVersionLogsUrl",
  "listEnvironmentVariables",
  "getEnvironmentVariable",
  "createEnvironmentVariable",
  "updateEnvironmentVariable",
  "deleteEnvironmentVariable",
  "listIntegrations",
  "listWorkspaceIntegrations",
  "getIntegration",
  "deleteIntegration",
  "revokeWorkspaceIntegration",
  "listScmInstallations",
  "createScmInstallIntent",
  "listScmInstallationRepositories",
  "listSourceRepositories",
  "getSourceRepository",
  "createSourceRepository",
  "deleteSourceRepository",
  "COMPUTE_MANIFEST_VERSION",
  "createComputeArchive",
  "normalizeEntrypoint",
  "runComputeAutoBuild",
  "parseComputeLogRecord",
  "tailComputeVersionLogs",
  "waitForComputeVersionStatus",
  "destroyComputeVersion",
  "destroyComputeService",
  "destroyComputeProject",
  "toDeploymentUrl",
  "syncComputeEnvironment",
  "readUploadArtifact",
  "uploadArtifact",
  "extractConnectionSecrets",
  "requestBody",
  "isNotFound",
  "isConflict",
  "fromProfile",
] as const;

describe("Prisma public surface", () => {
  it("exports the user-facing resources, providers, and operations", () => {
    const expected = [...publicExports].sort();

    expect(Object.keys(Prisma).sort()).toEqual(expected);
    expect(Prisma.KNOWN_REGION_IDS).toContain("us-east-1");
    expect(Prisma.REGIONS[0]).toEqual({
      id: Prisma.KNOWN_REGION_IDS[0],
      displayName: Prisma.KNOWN_REGION_IDS[0],
    });
  });

  it("exports the same surface through the alchemy/Prisma package path", () => {
    const expected = [...publicExports].sort();

    expect(Object.keys(PrismaPackage).sort()).toEqual(expected);
  });

  it("supports deep Prisma package path imports", async () => {
    const [compute, operations, client, archive, types, postgres] =
      await Promise.all([
        import("alchemy/Prisma/Compute"),
        import("alchemy/Prisma/Operations"),
        import("alchemy/Prisma/Client"),
        import("alchemy/Prisma/ComputeArchive"),
        import("alchemy/Prisma/Types"),
        import("alchemy/Prisma/Postgres"),
      ]);

    expect(compute.Compute.Type).toBe("Prisma.Compute");
    expect(typeof operations.listProjects).toBe("function");
    expect(typeof client.PrismaApiError).toBe("function");
    expect(archive.COMPUTE_MANIFEST_VERSION).toBe("1");
    expect(types.KNOWN_REGION_IDS).toContain("us-east-1");
    expect(postgres.Postgres.Type).toBe("Prisma.Database");
    expect(Prisma.Postgres).toBe(Prisma.Database);
  });

  it.effect("pins Prisma package export map entries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const packageJsonPath = path.resolve(
        import.meta.dirname,
        "../../package.json",
      );
      const packageJson = JSON.parse(yield* fs.readFileString(packageJsonPath));

      expect(packageJson.exports["./Prisma"]).toEqual({
        types: "./lib/Prisma/index.d.ts",
        bun: "./src/Prisma/index.ts",
        worker: "./src/Prisma/index.ts",
        import: "./lib/Prisma/index.js",
      });
      expect(packageJson.exports["./Prisma/*"]).toEqual({
        types: "./lib/Prisma/*.d.ts",
        bun: "./src/Prisma/*.ts",
        worker: "./src/Prisma/*.ts",
        import: "./lib/Prisma/*.js",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
