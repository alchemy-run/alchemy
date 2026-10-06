import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Providers from "@/Prisma";
import { isNotFound, type PrismaManagementClient } from "@/Prisma/Client";
import * as Prisma from "@/Prisma/Operations";
import * as Test from "@/Test/Alchemy";
import { expectGone, expectProjectGone } from "./fixtures/Live.ts";

const { test } = Test.make({ providers: Providers.providers() });

type AssertNever<T extends never> = T;
type ClientOperation = Exclude<keyof PrismaManagementClient, "request" | "paginate">;
export type PrismaOperationCoverage = [
  AssertNever<Exclude<ClientOperation, keyof typeof Prisma>>,
  AssertNever<Exclude<keyof typeof Prisma, ClientOperation>>,
];

const expectedOperationHelpers = [
  "listWorkspaces",
  "getWorkspace",
  "getCurrentPrincipal",
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
  "listBuckets",
  "getBucket",
  "createBucket",
  "deleteBucket",
  "listBucketKeys",
  "createBucketKey",
  "deleteBucketKey",
  "getCustomDomain",
  "deleteCustomDomain",
  "retryCustomDomain",
  "listApps",
  "getApp",
  "createApp",
  "updateApp",
  "deleteApp",
  "promoteApp",
  "rollbackApp",
  "listAppDomains",
  "createAppDomain",
  "listAppDeployments",
  "createAppDeployment",
  "getDeployment",
  "deleteDeployment",
  "startDeployment",
  "stopDeployment",
  "getDeploymentLogsRequest",
  "getBuildLogsRequest",
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
];

describe("Prisma operation helpers", { tags: ["unit", "provider:prisma", "local"] }, () => {
  it("export exactly one helper per PrismaClient operation", () => {
    expect(Object.keys(Prisma).sort()).toEqual([...expectedOperationHelpers].sort());
  });
});

test.provider(
  "operation helpers reach the Management API through the stack's client",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const me = yield* Prisma.getCurrentPrincipal();
    const workspaceId = me.workspace!.id;
    expect((yield* Prisma.getWorkspace(workspaceId)).id).toBe(workspaceId);
    expect((yield* Prisma.listPostgresRegions()).map((region) => region.id)).toContain("us-east-1");

    const { projectId } = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Providers.Project("Project", { createDatabase: false });
        return { projectId: project.projectId };
      }),
    );
    expect((yield* Prisma.getProject(projectId)).id).toBe(projectId);
    const branch = yield* Prisma.createBranch(projectId, { gitName: "operations/helper" });
    expect(
      (yield* Prisma.listBranches(projectId, { gitName: "operations/helper" })).map((b) => b.id),
    ).toEqual([branch.id]);
    yield* Prisma.deleteBranch(branch.id);
    yield* expectGone(
      Prisma.getBranch(branch.id).pipe(
        Effect.as(false),
        Effect.catchIf(isNotFound, () => Effect.succeed(true)),
      ),
    );

    // The log-request builders read the distilled Credentials, not the client.
    const logs = yield* Prisma.getDeploymentLogsRequest("cpv_1", { tail: 10 });
    expect(logs.url).toBe("wss://api.prisma.io/v1/deployments/cpv_1/logs?tail=10");
    expect(Redacted.value(logs.headers.Authorization)).toMatch(/^Bearer \S+$/);
    const build = yield* Prisma.getBuildLogsRequest("bld_1", { follow: true });
    expect(build.url).toBe("https://api.prisma.io/v1/builds/bld_1/logs?follow=true");

    yield* stack.destroy();
    yield* expectProjectGone(projectId);
  }),
  {
    tags: ["provider:prisma", "provider:prisma:project", "provider:prisma:branch", "live"],
    timeout: 120_000,
  },
);
