import {
  destroyComputeProject,
  destroyComputeService,
  destroyComputeVersion,
} from "@/Prisma/ComputeLifecycle";
import { PrismaApiError, type PrismaManagementClient } from "@/Prisma/Client";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

const makeClient = () => {
  const statuses = new Map([
    ["version-running", "running"],
    ["version-stopped", "stopped"],
  ]);
  const calls: string[] = [];
  const client = {
    listServiceComputeVersions: (serviceId: string) =>
      Effect.sync(() => {
        calls.push(`list:${serviceId}`);
        return Array.from(statuses.keys()).map((id) => ({
          id,
          type: "compute-version" as const,
          url: `https://api.test/${id}`,
          foundryVersionId: `foundry-${id}`,
          createdAt: "2026-01-01T00:00:00Z",
        }));
      }),
    getComputeServiceVersion: (versionId: string) =>
      Effect.sync(() => {
        calls.push(`get:${versionId}`);
        return {
          id: versionId,
          type: "compute-version" as const,
          url: `https://api.test/${versionId}`,
          foundryVersionId: `foundry-${versionId}`,
          status: statuses.get(versionId),
          previewDomain: `${versionId}.example.test`,
          createdAt: "2026-01-01T00:00:00Z",
        };
      }),
    stopComputeServiceVersion: (versionId: string) =>
      Effect.sync(() => {
        calls.push(`stop:${versionId}`);
        statuses.set(versionId, "stopped");
      }),
    deleteComputeServiceVersion: (versionId: string) =>
      Effect.sync(() => {
        calls.push(`delete:${versionId}`);
        statuses.delete(versionId);
      }),
    deleteComputeVersion: (versionId: string) =>
      Effect.sync(() => {
        calls.push(`delete-global:${versionId}`);
        statuses.delete(versionId);
      }),
    deleteComputeService: (serviceId: string) =>
      Effect.sync(() => {
        calls.push(`delete-service:${serviceId}`);
      }),
  } as unknown as PrismaManagementClient;
  return { client, calls };
};

describe("Prisma Compute lifecycle helpers", () => {
  it.effect("treats an already-deleted compute version as absent", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const client = {
        getComputeServiceVersion: (versionId: string) =>
          Effect.gen(function* () {
            calls.push(`get:${versionId}`);
            return yield* Effect.fail(
              new PrismaApiError({
                method: "GET",
                path: `/v1/compute-services/versions/${versionId}`,
                status: 404,
                message: "not found",
              }),
            );
          }),
        getComputeVersion: (versionId: string) =>
          Effect.gen(function* () {
            calls.push(`get-global:${versionId}`);
            return yield* Effect.fail(
              new PrismaApiError({
                method: "GET",
                path: `/v1/versions/${versionId}`,
                status: 404,
                message: "not found",
              }),
            );
          }),
      } as unknown as PrismaManagementClient;

      const result = yield* destroyComputeVersion(client, "missing-version");

      expect(result).toEqual({
        versionId: "missing-version",
        previousStatus: undefined,
        stopped: false,
        deleted: false,
      });
      expect(calls).toEqual([
        "get:missing-version",
        "get-global:missing-version",
      ]);
    }),
  );

  it.effect(
    "falls back to global version routes when service-scoped routes miss",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        let status = "running";
        const client = {
          getComputeServiceVersion: (versionId: string) =>
            Effect.gen(function* () {
              calls.push(`get:${versionId}`);
              return yield* Effect.fail(
                new PrismaApiError({
                  method: "GET",
                  path: `/v1/compute-services/versions/${versionId}`,
                  status: 404,
                  message: "not found",
                }),
              );
            }),
          getComputeVersion: (versionId: string) =>
            Effect.sync(() => {
              calls.push(`get-global:${versionId}`);
              return {
                id: versionId,
                type: "compute-version" as const,
                url: `https://api.test/${versionId}`,
                foundryVersionId: `foundry-${versionId}`,
                status,
                previewDomain: `${versionId}.example.test`,
                createdAt: "2026-01-01T00:00:00Z",
              };
            }),
          stopComputeServiceVersion: (versionId: string) =>
            Effect.gen(function* () {
              calls.push(`stop:${versionId}`);
              return yield* Effect.fail(
                new PrismaApiError({
                  method: "POST",
                  path: `/v1/compute-services/versions/${versionId}/stop`,
                  status: 404,
                  message: "not found",
                }),
              );
            }),
          stopComputeVersion: (versionId: string) =>
            Effect.sync(() => {
              calls.push(`stop-global:${versionId}`);
              status = "stopped";
            }),
          deleteComputeServiceVersion: (versionId: string) =>
            Effect.gen(function* () {
              calls.push(`delete:${versionId}`);
              return yield* Effect.fail(
                new PrismaApiError({
                  method: "DELETE",
                  path: `/v1/compute-services/versions/${versionId}`,
                  status: 404,
                  message: "not found",
                }),
              );
            }),
          deleteComputeVersion: (versionId: string) =>
            Effect.sync(() => {
              calls.push(`delete-global:${versionId}`);
            }),
        } as unknown as PrismaManagementClient;

        const result = yield* destroyComputeVersion(client, "version-global");

        expect(result).toEqual({
          versionId: "version-global",
          previousStatus: "running",
          stopped: true,
          deleted: true,
        });
        expect(calls).toEqual([
          "get:version-global",
          "get-global:version-global",
          "stop:version-global",
          "stop-global:version-global",
          "get:version-global",
          "get-global:version-global",
          "delete:version-global",
          "delete-global:version-global",
        ]);
      }),
  );

  it.effect(
    "preserves the service-scoped read error when global read also fails",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const client = {
          getComputeServiceVersion: (versionId: string) =>
            Effect.gen(function* () {
              calls.push(`get:${versionId}`);
              return yield* Effect.fail(
                new PrismaApiError({
                  method: "GET",
                  path: `/v1/compute-services/versions/${versionId}`,
                  status: 500,
                  message: "Internal Server Error",
                }),
              );
            }),
          getComputeVersion: (versionId: string) =>
            Effect.gen(function* () {
              calls.push(`get-global:${versionId}`);
              return yield* Effect.fail(
                new PrismaApiError({
                  method: "GET",
                  path: `/v1/versions/${versionId}`,
                  status: 404,
                  message: "not found",
                }),
              );
            }),
        } as unknown as PrismaManagementClient;

        const error = yield* destroyComputeVersion(
          client,
          "version-error",
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(PrismaApiError);
        expect((error as PrismaApiError).status).toBe(500);
        expect(calls).toEqual([
          "get:version-error",
          "get-global:version-error",
        ]);
      }),
  );

  it.effect(
    "preserves the service-scoped stop error without route fallback",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const client = {
          getComputeServiceVersion: (versionId: string) =>
            Effect.sync(() => {
              calls.push(`get:${versionId}`);
              return {
                id: versionId,
                type: "compute-version" as const,
                url: `https://api.test/${versionId}`,
                foundryVersionId: `foundry-${versionId}`,
                status: "running",
                previewDomain: `${versionId}.example.test`,
                createdAt: "2026-01-01T00:00:00Z",
              };
            }),
          stopComputeServiceVersion: (versionId: string) =>
            Effect.gen(function* () {
              calls.push(`stop:${versionId}`);
              return yield* Effect.fail(
                new PrismaApiError({
                  method: "POST",
                  path: `/v1/compute-services/versions/${versionId}/stop`,
                  status: 500,
                  message: "Internal Server Error",
                }),
              );
            }),
        } as unknown as PrismaManagementClient;

        const error = yield* destroyComputeVersion(
          client,
          "version-stop-error",
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(PrismaApiError);
        expect((error as PrismaApiError).status).toBe(500);
        expect(calls).toEqual([
          "get:version-stop-error",
          "stop:version-stop-error",
        ]);
      }),
  );

  it.effect("stops a running version before deleting it", () =>
    Effect.gen(function* () {
      const { client, calls } = makeClient();

      const result = yield* destroyComputeVersion(client, "version-running");

      expect(result).toEqual({
        versionId: "version-running",
        previousStatus: "running",
        stopped: true,
        deleted: true,
      });
      expect(calls).toEqual([
        "get:version-running",
        "stop:version-running",
        "get:version-running",
        "delete:version-running",
      ]);
    }),
  );

  it.effect("adds platform cleanup context when version delete fails", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const client = {
        getComputeServiceVersion: (versionId: string) =>
          Effect.sync(() => {
            calls.push(`get:${versionId}`);
            return {
              id: versionId,
              type: "compute-version" as const,
              url: `https://api.test/${versionId}`,
              foundryVersionId: `foundry-${versionId}`,
              status: "stopped",
              previewDomain: `${versionId}.example.test`,
              createdAt: "2026-01-01T00:00:00Z",
            };
          }),
        deleteComputeServiceVersion: (versionId: string) =>
          Effect.gen(function* () {
            calls.push(`delete:${versionId}`);
            return yield* Effect.fail(
              new PrismaApiError({
                method: "DELETE",
                path: `/v1/compute-services/versions/${versionId}`,
                status: 500,
                message: "Internal Server Error",
              }),
            );
          }),
        deleteComputeVersion: (versionId: string) =>
          Effect.gen(function* () {
            calls.push(`delete-global:${versionId}`);
            return yield* Effect.fail(
              new PrismaApiError({
                method: "DELETE",
                path: `/v1/versions/${versionId}`,
                status: 500,
                message: "Internal Server Error",
              }),
            );
          }),
      } as unknown as PrismaManagementClient;

      const error = yield* destroyComputeVersion(client, "version-stuck").pipe(
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Failed to delete Prisma compute version 'version-stuck'",
      );
      expect((error as Error).message).toContain(
        "while it was in status 'stopped'",
      );
      expect((error as Error).message).toContain(
        "Prisma API returned HTTP 500: Internal Server Error",
      );
      expect((error as Error).message).toContain(
        "known platform-side delete failure",
      );
      expect((error as Error).message).toContain(
        "DELETE /v1/versions/version-stuck",
      );
      expect(calls).toEqual([
        "get:version-stuck",
        "delete:version-stuck",
        "delete-global:version-stuck",
      ]);
    }),
  );

  it.effect(
    "reports the post-stop status when delete fails after stopping",
    () =>
      Effect.gen(function* () {
        const statuses = new Map([["version-running", "running"]]);
        const client = {
          getComputeServiceVersion: (versionId: string) =>
            Effect.sync(() => ({
              id: versionId,
              type: "compute-version" as const,
              url: `https://api.test/${versionId}`,
              foundryVersionId: `foundry-${versionId}`,
              status: statuses.get(versionId),
              previewDomain: `${versionId}.example.test`,
              createdAt: "2026-01-01T00:00:00Z",
            })),
          stopComputeServiceVersion: (versionId: string) =>
            Effect.sync(() => {
              statuses.set(versionId, "stopped");
            }),
          deleteComputeServiceVersion: (versionId: string) =>
            Effect.fail(
              new PrismaApiError({
                method: "DELETE",
                path: `/v1/compute-services/versions/${versionId}`,
                status: 500,
                message: "Internal Server Error",
              }),
            ),
          deleteComputeVersion: (versionId: string) =>
            Effect.fail(
              new PrismaApiError({
                method: "DELETE",
                path: `/v1/versions/${versionId}`,
                status: 500,
                message: "Internal Server Error",
              }),
            ),
        } as unknown as PrismaManagementClient;

        const error = yield* destroyComputeVersion(
          client,
          "version-running",
        ).pipe(Effect.flip);

        expect((error as Error).message).toContain(
          "while it was in status 'stopped'",
        );
        expect((error as Error).message).not.toContain(
          "while it was in status 'running'",
        );
      }),
  );

  it.effect(
    "falls back to global version delete when service-scoped delete fails",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const client = {
          getComputeServiceVersion: (versionId: string) =>
            Effect.sync(() => {
              calls.push(`get:${versionId}`);
              return {
                id: versionId,
                type: "compute-version" as const,
                url: `https://api.test/${versionId}`,
                foundryVersionId: `foundry-${versionId}`,
                status: "stopped",
                previewDomain: `${versionId}.example.test`,
                createdAt: "2026-01-01T00:00:00Z",
              };
            }),
          deleteComputeServiceVersion: (versionId: string) =>
            Effect.gen(function* () {
              calls.push(`delete:${versionId}`);
              return yield* Effect.fail(
                new PrismaApiError({
                  method: "DELETE",
                  path: `/v1/compute-services/versions/${versionId}`,
                  status: 500,
                  message: "Internal Server Error",
                }),
              );
            }),
          deleteComputeVersion: (versionId: string) =>
            Effect.sync(() => {
              calls.push(`delete-global:${versionId}`);
            }),
        } as unknown as PrismaManagementClient;

        const result = yield* destroyComputeVersion(client, "version-fallback");

        expect(result).toEqual({
          versionId: "version-fallback",
          previousStatus: "stopped",
          stopped: false,
          deleted: true,
        });
        expect(calls).toEqual([
          "get:version-fallback",
          "delete:version-fallback",
          "delete-global:version-fallback",
        ]);
      }),
  );

  it.effect("destroys every version before deleting the service", () =>
    Effect.gen(function* () {
      const { client, calls } = makeClient();

      const result = yield* destroyComputeService(client, "service-1");

      expect(result).toEqual({
        computeServiceId: "service-1",
        deletedVersionIds: ["version-running", "version-stopped"],
        serviceDeleted: true,
      });
      expect(calls).toEqual([
        "list:service-1",
        "get:version-running",
        "stop:version-running",
        "get:version-running",
        "delete:version-running",
        "get:version-stopped",
        "delete:version-stopped",
        "delete-service:service-1",
      ]);
    }),
  );

  it.effect("treats an already-deleted compute service as deleted", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const client = {
        listServiceComputeVersions: (serviceId: string) =>
          Effect.gen(function* () {
            calls.push(`list:${serviceId}`);
            return yield* Effect.fail(
              new PrismaApiError({
                method: "GET",
                path: `/v1/compute-services/${serviceId}/versions`,
                status: 404,
                message: "not found",
              }),
            );
          }),
        deleteComputeService: (serviceId: string) =>
          Effect.gen(function* () {
            calls.push(`delete-service:${serviceId}`);
            return yield* Effect.fail(
              new PrismaApiError({
                method: "DELETE",
                path: `/v1/compute-services/${serviceId}`,
                status: 404,
                message: "not found",
              }),
            );
          }),
      } as unknown as PrismaManagementClient;

      const result = yield* destroyComputeService(client, "missing-service");

      expect(result).toEqual({
        computeServiceId: "missing-service",
        deletedVersionIds: [],
        serviceDeleted: true,
      });
      expect(calls).toEqual([
        "list:missing-service",
        "delete-service:missing-service",
      ]);
    }),
  );

  it.effect(
    "tolerates a compute service disappearing during final delete",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const client = {
          listServiceComputeVersions: (serviceId: string) =>
            Effect.sync(() => {
              calls.push(`list:${serviceId}`);
              return [];
            }),
          deleteComputeService: (serviceId: string) =>
            Effect.gen(function* () {
              calls.push(`delete-service:${serviceId}`);
              return yield* Effect.fail(
                new PrismaApiError({
                  method: "DELETE",
                  path: `/v1/compute-services/${serviceId}`,
                  status: 404,
                  message: "not found",
                }),
              );
            }),
        } as unknown as PrismaManagementClient;

        const result = yield* destroyComputeService(client, "race-service");

        expect(result).toEqual({
          computeServiceId: "race-service",
          deletedVersionIds: [],
          serviceDeleted: true,
        });
        expect(calls).toEqual([
          "list:race-service",
          "delete-service:race-service",
        ]);
      }),
  );

  it.effect(
    "re-observes versions when compute service delete reports active versions",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        let deleteAttempts = 0;
        const client = {
          listServiceComputeVersions: (serviceId: string) =>
            Effect.sync(() => {
              calls.push(`list:${serviceId}`);
              return deleteAttempts === 0
                ? []
                : [
                    {
                      id: "late-version",
                      type: "compute-version" as const,
                      url: "https://api.test/late-version",
                      foundryVersionId: "foundry-late-version",
                      createdAt: "2026-01-01T00:00:00Z",
                    },
                  ];
            }),
          getComputeServiceVersion: (versionId: string) =>
            Effect.sync(() => {
              calls.push(`get:${versionId}`);
              return {
                id: versionId,
                type: "compute-version" as const,
                url: `https://api.test/${versionId}`,
                foundryVersionId: `foundry-${versionId}`,
                status: "stopped",
                previewDomain: `${versionId}.example.test`,
                createdAt: "2026-01-01T00:00:00Z",
              };
            }),
          deleteComputeServiceVersion: (versionId: string) =>
            Effect.sync(() => {
              calls.push(`delete:${versionId}`);
            }),
          deleteComputeVersion: (versionId: string) =>
            Effect.sync(() => {
              calls.push(`delete-global:${versionId}`);
            }),
          deleteComputeService: (serviceId: string) =>
            Effect.gen(function* () {
              calls.push(`delete-service:${serviceId}`);
              deleteAttempts += 1;
              if (deleteAttempts === 1) {
                return yield* Effect.fail(
                  new PrismaApiError({
                    method: "DELETE",
                    path: `/v1/compute-services/${serviceId}`,
                    status: 409,
                    message: "active compute versions exist",
                  }),
                );
              }
            }),
        } as unknown as PrismaManagementClient;

        const result = yield* destroyComputeService(client, "service-1");

        expect(result).toEqual({
          computeServiceId: "service-1",
          deletedVersionIds: ["late-version"],
          serviceDeleted: true,
        });
        expect(calls).toEqual([
          "list:service-1",
          "delete-service:service-1",
          "list:service-1",
          "get:late-version",
          "delete:late-version",
          "delete-service:service-1",
        ]);
      }),
  );

  it.effect("destroys every compute service before deleting the project", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const versionsByService = new Map([
        ["service-a", ["version-a1", "version-a2"]],
        ["service-b", ["version-b1"]],
      ]);
      const versionStatuses = new Map([
        ["version-a1", "running"],
        ["version-a2", "stopped"],
        ["version-b1", "stopped"],
      ]);
      const client = {
        listProjectComputeServices: (
          projectId: string,
          query?: { limit?: number },
        ) =>
          Effect.sync(() => {
            calls.push(`list-services:${projectId}:${query?.limit}`);
            return ["service-a", "service-b"].map((id) => ({
              id,
              type: "compute-service" as const,
              url: `https://api.test/${id}`,
              name: id,
              displayName: id,
              region: { id: "us-east-1", displayName: "us-east-1" },
              projectId,
              latestVersionId: null,
              createdAt: "2026-01-01T00:00:00Z",
            }));
          }),
        listServiceComputeVersions: (serviceId: string) =>
          Effect.sync(() => {
            calls.push(`list-versions:${serviceId}`);
            return (versionsByService.get(serviceId) ?? []).map((id) => ({
              id,
              type: "compute-version" as const,
              url: `https://api.test/${id}`,
              foundryVersionId: `foundry-${id}`,
              createdAt: "2026-01-01T00:00:00Z",
            }));
          }),
        getComputeServiceVersion: (versionId: string) =>
          Effect.sync(() => {
            calls.push(`get:${versionId}`);
            return {
              id: versionId,
              type: "compute-version" as const,
              url: `https://api.test/${versionId}`,
              foundryVersionId: `foundry-${versionId}`,
              status: versionStatuses.get(versionId),
              previewDomain: `${versionId}.example.test`,
              createdAt: "2026-01-01T00:00:00Z",
            };
          }),
        stopComputeServiceVersion: (versionId: string) =>
          Effect.sync(() => {
            calls.push(`stop:${versionId}`);
            versionStatuses.set(versionId, "stopped");
          }),
        deleteComputeServiceVersion: (versionId: string) =>
          Effect.sync(() => {
            calls.push(`delete-version:${versionId}`);
            versionStatuses.delete(versionId);
          }),
        deleteComputeVersion: (versionId: string) =>
          Effect.sync(() => {
            calls.push(`delete-version-global:${versionId}`);
            versionStatuses.delete(versionId);
          }),
        deleteComputeService: (serviceId: string) =>
          Effect.sync(() => {
            calls.push(`delete-service:${serviceId}`);
          }),
        deleteProject: (projectId: string) =>
          Effect.sync(() => {
            calls.push(`delete-project:${projectId}`);
          }),
      } as unknown as PrismaManagementClient;

      const result = yield* destroyComputeProject(client, "project-1");

      expect(result).toEqual({
        projectId: "project-1",
        deletedServiceIds: ["service-a", "service-b"],
        deletedVersionIds: ["version-a1", "version-a2", "version-b1"],
        projectDeleted: true,
      });
      expect(calls).toEqual([
        "list-services:project-1:100",
        "list-versions:service-a",
        "get:version-a1",
        "stop:version-a1",
        "get:version-a1",
        "delete-version:version-a1",
        "get:version-a2",
        "delete-version:version-a2",
        "delete-service:service-a",
        "list-versions:service-b",
        "get:version-b1",
        "delete-version:version-b1",
        "delete-service:service-b",
        "delete-project:project-1",
      ]);
    }),
  );

  it.effect(
    "re-observes compute services when project delete reports active versions",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        let deleteProjectAttempts = 0;
        const client = {
          listProjectComputeServices: (projectId: string) =>
            Effect.sync(() => {
              calls.push(`list-services:${projectId}`);
              return deleteProjectAttempts === 0
                ? []
                : [
                    {
                      id: "late-service",
                      type: "compute-service" as const,
                      url: "https://api.test/late-service",
                      name: "late-service",
                      displayName: "late-service",
                      region: { id: "us-east-1", displayName: "us-east-1" },
                      projectId,
                      latestVersionId: null,
                      createdAt: "2026-01-01T00:00:00Z",
                    },
                  ];
            }),
          listServiceComputeVersions: (serviceId: string) =>
            Effect.sync(() => {
              calls.push(`list-versions:${serviceId}`);
              return [
                {
                  id: "late-version",
                  type: "compute-version" as const,
                  url: "https://api.test/late-version",
                  foundryVersionId: "foundry-late-version",
                  createdAt: "2026-01-01T00:00:00Z",
                },
              ];
            }),
          getComputeServiceVersion: (versionId: string) =>
            Effect.sync(() => {
              calls.push(`get:${versionId}`);
              return {
                id: versionId,
                type: "compute-version" as const,
                url: `https://api.test/${versionId}`,
                foundryVersionId: `foundry-${versionId}`,
                status: "stopped",
                previewDomain: `${versionId}.example.test`,
                createdAt: "2026-01-01T00:00:00Z",
              };
            }),
          deleteComputeServiceVersion: (versionId: string) =>
            Effect.sync(() => {
              calls.push(`delete-version:${versionId}`);
            }),
          deleteComputeVersion: (versionId: string) =>
            Effect.sync(() => {
              calls.push(`delete-version-global:${versionId}`);
            }),
          deleteComputeService: (serviceId: string) =>
            Effect.sync(() => {
              calls.push(`delete-service:${serviceId}`);
            }),
          deleteProject: (projectId: string) =>
            Effect.gen(function* () {
              calls.push(`delete-project:${projectId}`);
              deleteProjectAttempts += 1;
              if (deleteProjectAttempts === 1) {
                return yield* Effect.fail(
                  new PrismaApiError({
                    method: "DELETE",
                    path: `/v1/projects/${projectId}`,
                    status: 409,
                    message: "active compute versions exist",
                  }),
                );
              }
            }),
        } as unknown as PrismaManagementClient;

        const result = yield* destroyComputeProject(client, "project-1");

        expect(result).toEqual({
          projectId: "project-1",
          deletedServiceIds: ["late-service"],
          deletedVersionIds: ["late-version"],
          projectDeleted: true,
        });
        expect(calls).toEqual([
          "list-services:project-1",
          "delete-project:project-1",
          "list-services:project-1",
          "list-versions:late-service",
          "get:late-version",
          "delete-version:late-version",
          "delete-service:late-service",
          "delete-project:project-1",
        ]);
      }),
  );

  it.effect("treats an already-deleted compute project as gone", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const client = {
        listProjectComputeServices: (projectId: string) =>
          Effect.gen(function* () {
            calls.push(`list-services:${projectId}`);
            return yield* Effect.fail(
              new PrismaApiError({
                method: "GET",
                path: `/v1/projects/${projectId}/compute-services`,
                status: 404,
                message: "not found",
              }),
            );
          }),
        deleteProject: (projectId: string) =>
          Effect.gen(function* () {
            calls.push(`delete-project:${projectId}`);
            return yield* Effect.fail(
              new PrismaApiError({
                method: "DELETE",
                path: `/v1/projects/${projectId}`,
                status: 404,
                message: "not found",
              }),
            );
          }),
      } as unknown as PrismaManagementClient;

      const result = yield* destroyComputeProject(client, "missing-project");

      expect(result).toEqual({
        projectId: "missing-project",
        deletedServiceIds: [],
        deletedVersionIds: [],
        projectDeleted: true,
      });
      expect(calls).toEqual([
        "list-services:missing-project",
        "delete-project:missing-project",
      ]);
    }),
  );

  it.effect(
    "tolerates a compute project disappearing during final delete",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const client = {
          listProjectComputeServices: (projectId: string) =>
            Effect.sync(() => {
              calls.push(`list-services:${projectId}`);
              return [];
            }),
          deleteProject: (projectId: string) =>
            Effect.gen(function* () {
              calls.push(`delete-project:${projectId}`);
              return yield* Effect.fail(
                new PrismaApiError({
                  method: "DELETE",
                  path: `/v1/projects/${projectId}`,
                  status: 404,
                  message: "not found",
                }),
              );
            }),
        } as unknown as PrismaManagementClient;

        const result = yield* destroyComputeProject(client, "race-project");

        expect(result).toEqual({
          projectId: "race-project",
          deletedServiceIds: [],
          deletedVersionIds: [],
          projectDeleted: true,
        });
        expect(calls).toEqual([
          "list-services:race-project",
          "delete-project:race-project",
        ]);
      }),
  );

  it.effect("can keep the project while deleting compute services", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const client = {
        listProjectComputeServices: (projectId: string) =>
          Effect.sync(() => {
            calls.push(`list-services:${projectId}`);
            return [
              {
                id: "service-a",
                type: "compute-service" as const,
                url: "https://api.test/service-a",
                name: "service-a",
                displayName: "service-a",
                region: { id: "us-east-1", displayName: "us-east-1" },
                projectId,
                latestVersionId: null,
                createdAt: "2026-01-01T00:00:00Z",
              },
            ];
          }),
        listServiceComputeVersions: (serviceId: string) =>
          Effect.sync(() => {
            calls.push(`list-versions:${serviceId}`);
            return [];
          }),
        deleteComputeService: (serviceId: string) =>
          Effect.sync(() => {
            calls.push(`delete-service:${serviceId}`);
          }),
        deleteProject: (projectId: string) =>
          Effect.sync(() => {
            calls.push(`delete-project:${projectId}`);
          }),
      } as unknown as PrismaManagementClient;

      const result = yield* destroyComputeProject(client, "project-1", {
        keepProject: true,
      });

      expect(result).toEqual({
        projectId: "project-1",
        deletedServiceIds: ["service-a"],
        deletedVersionIds: [],
        projectDeleted: false,
      });
      expect(calls).toEqual([
        "list-services:project-1",
        "list-versions:service-a",
        "delete-service:service-a",
      ]);
    }),
  );
});
