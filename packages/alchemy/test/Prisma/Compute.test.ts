import {
  Compute,
  ComputeDevProvider,
  ComputeProvider,
  syncComputeEnvironment,
} from "@/Prisma/Compute";
import { AlchemyContext } from "@/AlchemyContext";
import {
  PrismaApiError,
  PrismaClient,
  type PrismaManagementClient,
} from "@/Prisma/Client";
import * as Output from "@/Output";
import type { ResourceBinding } from "@/Resource";
import { PlatformServices } from "@/Util/PlatformServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { gunzipSync } from "node:zlib";
import { WebSocketServer } from "ws";

describe("Prisma Compute", () => {
  it.effect("rejects destroyOldVersion when promotion is skipped", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            serviceName: "api",
            skipPromote: true,
            destroyOldVersion: true,
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "destroyOldVersion cannot be combined with skipPromote",
      );
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
    );
  });

  it.effect("rejects conflicting branch attachment inputs", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            serviceName: "api",
            branchId: "branch-1",
            branchGitName: "main",
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "branchId and branchGitName are mutually exclusive",
      );
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
    );
  });

  it.effect("rejects effect-native Compute without a main module", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            serviceName: "api",
            exports: { default: "runtime" },
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Effect-native Prisma Compute apps require `main`",
      );
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
    );
  });

  it.effect("rejects effect-native Compute with an external build", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            serviceName: "api",
            main: "app.ts",
            build: {
              command: "bun run build",
              outdir: "dist",
            },
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Effect-native Prisma Compute apps cannot use build",
      );
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
    );
  });

  it.effect(
    "rejects effect-native Compute with an invalid handler name",
    () => {
      const client = {} as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const error = yield* provider
          .reconcile({
            id: "App",
            instanceId: "00000000000000000000000000000000",
            news: {
              project: "project-1",
              serviceName: "api",
              main: "app.ts",
              handler: "Api;console.log('nope')",
            },
            olds: undefined,
            output: undefined,
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          "handler must be `default` or a valid JavaScript export identifier",
        );
      }).pipe(
        Effect.provide(ComputeProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
      );
    },
  );

  it.effect(
    "replaces Compute when region changes even if project is unresolved",
    () => {
      const client = {} as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const diff = yield* provider.diff!({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          olds: {
            project: "project-1",
            serviceName: "api",
            regionId: "us-east-1",
          },
          news: {
            project: Output.asOutput("project-1"),
            serviceName: "api",
            regionId: "us-west-2",
          },
          oldBindings: [],
          newBindings: [],
          output: {
            computeServiceId: "service-1",
            computeVersionId: "version-1",
            projectId: "project-1",
            serviceName: "api",
            regionId: "us-east-1",
            versionEndpointDomain: "version-1.preview.prisma.build",
            versionUrl: "https://version-1.preview.prisma.build",
            serviceEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: true,
            previousVersionId: undefined,
            previousVersionAction: undefined,
            artifactHash: "hash-1",
            local: false,
          },
        } as never);

        expect(diff).toEqual({ action: "replace" });
      }).pipe(
        Effect.provide(ComputeProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
      );
    },
  );

  it.effect(
    "replaces Compute when project changes even if region is unresolved",
    () => {
      const client = {} as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const diff = yield* provider.diff!({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          olds: {
            project: "project-1",
            serviceName: "api",
            regionId: "us-east-1",
          },
          news: {
            project: "project-2",
            serviceName: "api",
            regionId: Output.asOutput("us-east-1"),
          },
          oldBindings: [],
          newBindings: [],
          output: {
            computeServiceId: "service-1",
            computeVersionId: "version-1",
            projectId: "project-1",
            serviceName: "api",
            regionId: "us-east-1",
            versionEndpointDomain: "version-1.preview.prisma.build",
            versionUrl: "https://version-1.preview.prisma.build",
            serviceEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: true,
            previousVersionId: undefined,
            previousVersionAction: undefined,
            artifactHash: "hash-1",
            local: false,
          },
        } as never);

        expect(diff).toEqual({ action: "replace" });
      }).pipe(
        Effect.provide(ComputeProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
      );
    },
  );

  it.effect(
    "updates Compute when props are unchanged so artifacts can rehash",
    () => {
      const client = {} as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const diff = yield* provider.diff!({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          olds: {
            project: "project-1",
            serviceName: "api",
            regionId: "us-east-1",
            path: ".",
            entrypoint: "server.ts",
          },
          news: {
            project: "project-1",
            serviceName: "api",
            regionId: "us-east-1",
            path: ".",
            entrypoint: "server.ts",
          },
          oldBindings: [],
          newBindings: [],
          output: {
            computeServiceId: "service-1",
            computeVersionId: "version-1",
            projectId: "project-1",
            serviceName: "api",
            regionId: "us-east-1",
            versionEndpointDomain: "version-1.preview.prisma.build",
            versionUrl: "https://version-1.preview.prisma.build",
            serviceEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: true,
            previousVersionId: undefined,
            previousVersionAction: undefined,
            artifactHash: "hash-1",
            local: false,
          },
        } as never);

        expect(diff).toEqual({ action: "update" });
      }).pipe(
        Effect.provide(ComputeProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
      );
    },
  );

  it.effect("dev provider applies the same Compute prop validation", () =>
    Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            serviceName: "api",
            skipPromote: true,
            destroyOldVersion: true,
            dev: {
              url: "http://localhost:3000",
            },
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "destroyOldVersion cannot be combined with skipPromote",
      );
    }).pipe(
      Effect.provide(ComputeDevProvider()),
      Effect.provide(
        Layer.succeed(AlchemyContext, {
          dotAlchemy: ".alchemy",
          updateStateStore: false,
          dev: true,
          adopt: false,
        }),
      ),
      Effect.provide(PlatformServices),
    ),
  );

  it.effect("reads the live latest version when adopting Compute", () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      listProjectComputeServices: (projectId: string, query: unknown) => {
        calls.push(["listProjectComputeServices", { projectId, query }]);
        return Effect.succeed([
          {
            id: "service-1",
            type: "compute-service" as const,
            url: "https://api.prisma.test/v1/compute-services/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId,
            branchId: "branch-main",
            latestVersionId: "version-live",
            serviceEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ]);
      },
      getComputeServiceVersion: (id: string) => {
        calls.push(["getComputeServiceVersion", id]);
        return Effect.succeed({
          id,
          type: "compute-version" as const,
          url: `https://api.prisma.test/v1/versions/${id}`,
          foundryVersionId: "foundry-live",
          status: "running",
          previewDomain: "version-live.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const output = yield* provider.read!({
        id: "App",
        instanceId: "00000000000000000000000000000000",
        olds: {
          project: "project-1",
          serviceName: "api",
        },
        output: undefined,
      });

      expect(output?.computeServiceId).toBe("service-1");
      expect(output?.computeVersionId).toBe("version-live");
      expect(output?.versionEndpointDomain).toBe(
        "version-live.preview.prisma.build",
      );
      expect(output?.versionUrl).toBe(
        "https://version-live.preview.prisma.build",
      );
      expect(output?.serviceEndpointDomain).toBe("api.prisma.build");
      expect(output?.url).toBe("https://api.prisma.build");
      expect(output?.promoted).toBe(true);
      expect(calls).toEqual([
        [
          "listProjectComputeServices",
          { projectId: "project-1", query: { limit: 100 } },
        ],
        ["getComputeServiceVersion", "version-live"],
      ]);
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "falls back to the global version route when Compute read sees a service-scoped miss",
    () => {
      const calls: Array<[string, unknown]> = [];
      const client = {
        listProjectComputeServices: (projectId: string, query: unknown) => {
          calls.push(["listProjectComputeServices", { projectId, query }]);
          return Effect.succeed([
            {
              id: "service-1",
              type: "compute-service" as const,
              url: "https://api.prisma.test/v1/compute-services/service-1",
              name: "api",
              region: { id: "us-east-1", name: "US East" },
              projectId,
              branchId: "branch-main",
              latestVersionId: "version-live",
              serviceEndpointDomain: "api.prisma.build",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ]);
        },
        getComputeServiceVersion: (id: string) => {
          calls.push(["getComputeServiceVersion", id]);
          return Effect.fail(
            new PrismaApiError({
              method: "GET",
              path: `/v1/compute-services/versions/${id}`,
              status: 404,
              message: "not found",
            }),
          );
        },
        getComputeVersion: (id: string) => {
          calls.push(["getComputeVersion", id]);
          return Effect.succeed({
            id,
            type: "compute-version" as const,
            url: `https://api.prisma.test/v1/versions/${id}`,
            foundryVersionId: "foundry-live",
            status: "running",
            previewDomain: "version-live.preview.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const output = yield* provider.read!({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          olds: {
            project: "project-1",
            serviceName: "api",
          },
          output: undefined,
        });

        expect(output?.computeVersionId).toBe("version-live");
        expect(output?.promoted).toBe(true);
        expect(output?.versionUrl).toBe(
          "https://version-live.preview.prisma.build",
        );
        expect(calls).toEqual([
          [
            "listProjectComputeServices",
            { projectId: "project-1", query: { limit: 100 } },
          ],
          ["getComputeServiceVersion", "version-live"],
          ["getComputeVersion", "version-live"],
        ]);
      }).pipe(
        Effect.provide(ComputeProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect(
    "marks stored Compute version unpromoted when live latest differs",
    () => {
      const calls: Array<[string, unknown]> = [];
      const client = {
        getComputeService: (id: string) => {
          calls.push(["getComputeService", id]);
          return Effect.succeed({
            id,
            type: "compute-service" as const,
            url: "https://api.prisma.test/v1/compute-services/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: "branch-main",
            latestVersionId: "version-live",
            serviceEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        getComputeServiceVersion: (id: string) => {
          calls.push(["getComputeServiceVersion", id]);
          return Effect.succeed({
            id,
            type: "compute-version" as const,
            url: `https://api.prisma.test/v1/versions/${id}`,
            foundryVersionId: `foundry-${id}`,
            status: "running",
            previewDomain: `${id}.preview.prisma.build`,
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const output = yield* provider.read!({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          olds: {
            project: "project-1",
            serviceName: "api",
          },
          output: {
            computeServiceId: "service-1",
            computeVersionId: "version-old",
            projectId: "project-1",
            serviceName: "api",
            regionId: "us-east-1",
            versionEndpointDomain: "version-old.preview.prisma.build",
            versionUrl: "https://version-old.preview.prisma.build",
            serviceEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: true,
            previousVersionId: undefined,
            previousVersionAction: undefined,
            artifactHash: "hash-old",
            local: false,
          },
        });

        expect(output?.computeVersionId).toBe("version-old");
        expect(output?.promoted).toBe(false);
        expect(output?.versionEndpointDomain).toBe(
          "version-old.preview.prisma.build",
        );
        expect(calls).toEqual([
          ["getComputeService", "service-1"],
          ["getComputeServiceVersion", "version-old"],
        ]);
      }).pipe(
        Effect.provide(ComputeProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect(
    "syncs a newly created service branch before creating a version",
    () => {
      const calls: Array<[string, unknown]> = [];
      const client = {
        listProjectComputeServices: (projectId: string, query: unknown) => {
          calls.push(["listProjectComputeServices", { projectId, query }]);
          return Effect.succeed([]);
        },
        createProjectComputeService: (projectId: string, input: unknown) => {
          calls.push(["createProjectComputeService", { projectId, input }]);
          return Effect.succeed({
            id: "service-1",
            type: "compute-service" as const,
            url: "https://api.prisma.test/v1/compute-services/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId,
            branchId: null,
            latestVersionId: null,
            serviceEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        updateComputeService: (id: string, input: unknown) => {
          calls.push(["updateComputeService", { id, input }]);
          return Effect.succeed({
            id,
            type: "compute-service" as const,
            url: "https://api.prisma.test/v1/compute-services/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: "branch-main",
            latestVersionId: null,
            serviceEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        createServiceComputeVersion: (
          computeServiceId: string,
          input: unknown,
        ) => {
          calls.push([
            "createServiceComputeVersion",
            { computeServiceId, input },
          ]);
          return Effect.succeed({
            id: "version-1",
            type: "compute-version" as const,
            url: "https://api.prisma.test/v1/versions/version-1",
            foundryVersionId: "foundry-1",
            uploadUrl: null,
          });
        },
        getComputeServiceVersion: (id: string) => {
          calls.push(["getComputeServiceVersion", id]);
          return Effect.succeed({
            id,
            type: "compute-version" as const,
            url: "https://api.prisma.test/v1/versions/version-1",
            foundryVersionId: "foundry-1",
            status: "new",
            previewDomain: "version-1.preview.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const output = yield* provider.reconcile({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            serviceName: "api",
            branchId: "branch-main",
            skipCodeUpload: true,
            start: false,
            skipPromote: true,
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        });

        expect(output.computeServiceId).toBe("service-1");
        expect(output.computeVersionId).toBe("version-1");
        expect(calls).toContainEqual([
          "createProjectComputeService",
          {
            projectId: "project-1",
            input: {
              displayName: "api",
              regionId: "us-east-1",
              branchId: "branch-main",
              branchGitName: undefined,
            },
          },
        ]);
        expect(calls).toContainEqual([
          "updateComputeService",
          {
            id: "service-1",
            input: {
              displayName: "api",
              branchId: "branch-main",
              branchGitName: undefined,
            },
          },
        ]);
        const updateIndex = calls.findIndex(
          ([name]) => name === "updateComputeService",
        );
        const versionIndex = calls.findIndex(
          ([name]) => name === "createServiceComputeVersion",
        );
        expect(updateIndex).toBeGreaterThan(-1);
        expect(versionIndex).toBeGreaterThan(updateIndex);
      }).pipe(
        Effect.provide(ComputeProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
      );
    },
  );

  it.effect(
    "does not mutate remote Compute state when artifact resolution fails",
    () => {
      const calls: Array<[string, unknown?]> = [];
      const client = {
        listProjectComputeServices: (projectId: string, query: unknown) => {
          calls.push(["listProjectComputeServices", { projectId, query }]);
          return Effect.succeed([]);
        },
        createProjectComputeService: (projectId: string, input: unknown) => {
          calls.push(["createProjectComputeService", { projectId, input }]);
          return Effect.die("should not create service");
        },
        listEnvironmentVariables: (query: unknown) => {
          calls.push(["listEnvironmentVariables", query]);
          return Effect.succeed([]);
        },
        createEnvironmentVariable: (input: unknown) => {
          calls.push(["createEnvironmentVariable", input]);
          return Effect.die("should not create env");
        },
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const path = yield* Path.Path;
        const missingArtifact = path.resolve(
          "tmp",
          "alchemy-prisma-missing-artifact.tar.gz",
        );

        const provider = yield* Compute.Provider;
        const error = yield* provider
          .reconcile({
            id: "App",
            instanceId: "00000000000000000000000000000000",
            news: {
              project: "project-1",
              serviceName: "api",
              artifactPath: missingArtifact,
              env: {
                TOKEN: "secret",
              },
            },
            olds: undefined,
            output: undefined,
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect(error).toBeDefined();
        expect(calls).toEqual([]);
      }).pipe(
        Effect.provide(ComputeProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("fails when Prisma omits an upload URL for app artifacts", () => {
    const calls: Array<[string, unknown?]> = [];
    const client = {
      getComputeService: () => {
        calls.push(["getComputeService"]);
        return Effect.succeed({
          id: "service-1",
          type: "compute-service" as const,
          url: "https://api.prisma.test/v1/compute-services/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: null,
          latestVersionId: null,
          serviceEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      listEnvironmentVariables: () => Effect.succeed([]),
      createServiceComputeVersion: () => {
        calls.push(["createServiceComputeVersion"]);
        return Effect.succeed({
          id: "version-1",
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: null,
        });
      },
      getComputeServiceVersion: (id: string) => {
        calls.push(["getComputeServiceVersion", id]);
        return Effect.succeed({
          id,
          type: "compute-version" as const,
          url: `https://api.prisma.test/v1/versions/${id}`,
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: null,
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      deleteComputeServiceVersion: (id: string) => {
        calls.push(["deleteComputeServiceVersion", id]);
        return Effect.void;
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            serviceName: "api",
            artifact: "archive-bytes",
            branchId: null,
            start: false,
            skipPromote: true,
          },
          olds: undefined,
          output: {
            computeServiceId: "service-1",
            computeVersionId: undefined,
            projectId: "project-1",
            serviceName: "api",
            regionId: "us-east-1",
            versionEndpointDomain: undefined,
            versionUrl: undefined,
            serviceEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: false,
            previousVersionId: undefined,
            previousVersionAction: undefined,
            artifactHash: undefined,
            local: false,
          },
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "did not return an upload URL",
      );
      expect(calls).toContainEqual([
        "deleteComputeServiceVersion",
        "version-1",
      ]);
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "deletes created Compute version when artifact upload fails",
    () => {
      const calls: Array<[string, unknown?]> = [];
      const client = {
        getComputeService: () =>
          Effect.succeed({
            id: "service-1",
            type: "compute-service" as const,
            url: "https://api.prisma.test/v1/compute-services/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: null,
            latestVersionId: null,
            serviceEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          }),
        listEnvironmentVariables: () => Effect.succeed([]),
        createServiceComputeVersion: () => {
          calls.push(["createServiceComputeVersion"]);
          return Effect.succeed({
            id: "version-1",
            type: "compute-version" as const,
            url: "https://api.prisma.test/v1/versions/version-1",
            foundryVersionId: "foundry-1",
            uploadUrl: "https://upload.prisma.test/app.tar.gz",
          });
        },
        getComputeServiceVersion: (id: string) => {
          calls.push(["getComputeServiceVersion", id]);
          return Effect.succeed({
            id,
            type: "compute-version" as const,
            url: `https://api.prisma.test/v1/versions/${id}`,
            foundryVersionId: "foundry-1",
            status: "new",
            previewDomain: null,
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        deleteComputeServiceVersion: (id: string) => {
          calls.push(["deleteComputeServiceVersion", id]);
          return Effect.void;
        },
      } as unknown as PrismaManagementClient;
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response("upload failed", { status: 500 }),
          ),
        ),
      );

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const error = yield* provider
          .reconcile({
            id: "App",
            instanceId: "00000000000000000000000000000000",
            news: {
              project: "project-1",
              serviceName: "api",
              artifact: "archive-bytes",
              branchId: null,
              start: false,
              skipPromote: true,
            },
            olds: undefined,
            output: {
              computeServiceId: "service-1",
              computeVersionId: undefined,
              projectId: "project-1",
              serviceName: "api",
              regionId: "us-east-1",
              versionEndpointDomain: undefined,
              versionUrl: undefined,
              serviceEndpointDomain: "api.prisma.build",
              url: "https://api.prisma.build",
              promoted: false,
              previousVersionId: undefined,
              previousVersionAction: undefined,
              artifactHash: undefined,
              local: false,
            },
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("artifact upload failed");
        expect(calls).toContainEqual([
          "deleteComputeServiceVersion",
          "version-1",
        ]);
      }).pipe(
        Effect.provide(ComputeProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
        Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("uploads a pre-created artifact from artifactPath", () => {
    let uploaded:
      | { url: string; contentType: string | undefined; bytes: Uint8Array }
      | undefined;
    const client = {
      getComputeService: () =>
        Effect.succeed({
          id: "service-1",
          type: "compute-service" as const,
          url: "https://api.prisma.test/v1/compute-services/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: null,
          latestVersionId: null,
          serviceEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        }),
      listEnvironmentVariables: () => Effect.succeed([]),
      createServiceComputeVersion: () =>
        Effect.succeed({
          id: "version-1",
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: "https://upload.prisma.test/app.tar.gz",
        }),
      getComputeServiceVersion: (id: string) =>
        Effect.succeed({
          id,
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-1",
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: "version-1.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        }),
    } as unknown as PrismaManagementClient;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const body = request.body as HttpBody.HttpBody;
        uploaded = {
          url: request.url,
          contentType:
            body._tag === "Uint8Array" ? body.contentType : undefined,
          bytes: body._tag === "Uint8Array" ? body.body : new Uint8Array(),
        };
        return HttpClientResponse.fromWeb(request, new Response(null));
      }),
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-artifact-",
      });
      const artifactPath = path.join(root, "app.tar.gz");
      yield* fs.writeFileString(artifactPath, "prebuilt-archive");

      const provider = yield* Compute.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          serviceName: "api",
          artifactPath,
          branchId: null,
          start: false,
          skipPromote: true,
        },
        olds: undefined,
        output: {
          computeServiceId: "service-1",
          computeVersionId: undefined,
          projectId: "project-1",
          serviceName: "api",
          regionId: "us-east-1",
          versionEndpointDomain: undefined,
          versionUrl: undefined,
          serviceEndpointDomain: "api.prisma.build",
          url: "https://api.prisma.build",
          promoted: false,
          previousVersionId: undefined,
          previousVersionAction: undefined,
          artifactHash: undefined,
          local: false,
        },
        session: undefined as never,
        bindings: [],
      });

      expect(output.computeVersionId).toBe("version-1");
      expect(uploaded?.url).toBe("https://upload.prisma.test/app.tar.gz");
      expect(uploaded?.contentType).toBe("application/gzip");
      expect(new TextDecoder().decode(uploaded?.bytes)).toBe(
        "prebuilt-archive",
      );
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "bundles effect-native Compute apps into an upload artifact",
    () => {
      const calls: Array<[string, unknown]> = [];
      let uploaded:
        | { url: string; contentType: string | undefined; bytes: Uint8Array }
        | undefined;
      const client = {
        listProjectComputeServices: (projectId: string, query: unknown) => {
          calls.push(["listProjectComputeServices", { projectId, query }]);
          return Effect.succeed([]);
        },
        createProjectComputeService: (projectId: string, input: unknown) => {
          calls.push(["createProjectComputeService", { projectId, input }]);
          return Effect.succeed({
            id: "service-1",
            type: "compute-service" as const,
            url: "https://api.prisma.test/v1/compute-services/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId,
            branchId: null,
            latestVersionId: null,
            serviceEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        listEnvironmentVariables: () => Effect.succeed([]),
        createServiceComputeVersion: (
          computeServiceId: string,
          input: unknown,
        ) => {
          calls.push([
            "createServiceComputeVersion",
            { computeServiceId, input },
          ]);
          return Effect.succeed({
            id: "version-1",
            type: "compute-version" as const,
            url: "https://api.prisma.test/v1/versions/version-1",
            foundryVersionId: "foundry-1",
            uploadUrl: "https://upload.prisma.test/effect.tar.gz",
          });
        },
        getComputeServiceVersion: (id: string) => {
          calls.push(["getComputeServiceVersion", id]);
          return Effect.succeed({
            id,
            type: "compute-version" as const,
            url: "https://api.prisma.test/v1/versions/version-1",
            foundryVersionId: "foundry-1",
            status: "new",
            previewDomain: "version-1.preview.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
      } as unknown as PrismaManagementClient;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const body = request.body as HttpBody.HttpBody;
          uploaded = {
            url: request.url,
            contentType:
              body._tag === "Uint8Array" ? body.contentType : undefined,
            bytes: body._tag === "Uint8Array" ? body.body : new Uint8Array(),
          };
          return HttpClientResponse.fromWeb(request, new Response(null));
        }),
      );

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-prisma-compute-effect-",
        });
        const main = path.join(root, "app.ts");
        yield* fs.writeFileString(
          main,
          [
            'import * as Prisma from "alchemy/Prisma";',
            'import * as Effect from "effect/Effect";',
            'import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";',
            "",
            "export default Prisma.Compute(",
            '  "App",',
            "  {",
            '    project: "project-1",',
            '    serviceName: "api",',
            "    main: import.meta.filename,",
            "    port: 4555,",
            "  },",
            "  Effect.gen(function* () {",
            "    return {",
            '      fetch: HttpServerResponse.text("effect-native-ok"),',
            "    };",
            "  }),",
            ");",
            "",
          ].join("\n"),
        );

        const provider = yield* Compute.Provider;
        const output = yield* provider.reconcile({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            serviceName: "api",
            branchGitName: null,
            main,
            port: 4555,
            start: false,
            skipPromote: true,
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        });

        expect(output.computeVersionId).toBe("version-1");
        expect(uploaded?.url).toBe("https://upload.prisma.test/effect.tar.gz");
        expect(uploaded?.contentType).toBe("application/gzip");
        const tarText = new TextDecoder().decode(
          yield* Effect.sync(() => gunzipSync(uploaded!.bytes)),
        );
        expect(tarText).toContain("compute.manifest.json");
        expect(tarText).toContain("bundle/index.js");
        expect(tarText).toContain("Prisma Compute bootstrap starting");
        expect(tarText.includes("ALCHEMY_PHASE")).toBe(true);
        expect(tarText.includes("runtime")).toBe(true);
        expect(tarText).toContain("effect-native-ok");
        expect(calls).toContainEqual([
          "createServiceComputeVersion",
          {
            computeServiceId: "service-1",
            input: {
              portMapping: { http: 4555 },
              skipCodeUpload: undefined,
            },
          },
        ]);
      }).pipe(
        Effect.provide(ComputeProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
        Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("bundles effect-native Compute apps from a named export", () => {
    let uploaded: Uint8Array | undefined;
    const client = {
      listProjectComputeServices: () => Effect.succeed([]),
      createProjectComputeService: (projectId: string) =>
        Effect.succeed({
          id: "service-1",
          type: "compute-service" as const,
          url: "https://api.prisma.test/v1/compute-services/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId,
          branchId: null,
          latestVersionId: null,
          serviceEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        }),
      listEnvironmentVariables: () => Effect.succeed([]),
      createServiceComputeVersion: () =>
        Effect.succeed({
          id: "version-1",
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: "https://upload.prisma.test/effect.tar.gz",
        }),
      getComputeServiceVersion: (id: string) =>
        Effect.succeed({
          id,
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-1",
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: "version-1.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        }),
    } as unknown as PrismaManagementClient;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const body = request.body as HttpBody.HttpBody;
        uploaded = body._tag === "Uint8Array" ? body.body : undefined;
        return HttpClientResponse.fromWeb(request, new Response(null));
      }),
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-named-effect-",
      });
      const main = path.join(root, "app.ts");
      yield* fs.writeFileString(
        main,
        [
          'import * as Prisma from "alchemy/Prisma";',
          'import * as Effect from "effect/Effect";',
          'import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";',
          "",
          "export const Api = Prisma.Compute(",
          '  "App",',
          "  {",
          '    project: "project-1",',
          '    serviceName: "api",',
          "    main: import.meta.filename,",
          '    handler: "Api",',
          "  },",
          "  Effect.gen(function* () {",
          "    return {",
          '      fetch: HttpServerResponse.text("named-handler-ok"),',
          "    };",
          "  }),",
          ");",
          "",
        ].join("\n"),
      );

      const provider = yield* Compute.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          serviceName: "api",
          branchGitName: null,
          main,
          handler: "Api",
          start: false,
          skipPromote: true,
        },
        olds: undefined,
        output: undefined,
        session: undefined as never,
        bindings: [],
      });

      expect(output.computeVersionId).toBe("version-1");
      const tarText = new TextDecoder().decode(
        yield* Effect.sync(() => gunzipSync(uploaded!)),
      );
      expect(tarText).toContain("compute.manifest.json");
      expect(tarText).toContain("named-handler-ok");
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("syncs env vars through the environment variable API", () => {
    const calls: Array<[string, unknown]> = [];
    const projectToken = {
      id: "env-token",
      type: "environment-variable" as const,
      url: "https://api.prisma.test/v1/environment-variables/env-token",
      projectId: "project-1",
      branchId: null,
      class: "production" as const,
      key: "TOKEN",
      valueKid: "kid-1",
      isManagedBySystem: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const projectRemove = {
      id: "env-remove",
      type: "environment-variable" as const,
      url: "https://api.prisma.test/v1/environment-variables/env-remove",
      projectId: "project-1",
      branchId: null,
      class: "production" as const,
      key: "REMOVE_ME",
      valueKid: "kid-1",
      isManagedBySystem: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const byKey = new Map([
      [
        "TOKEN",
        [
          { ...projectToken, id: "env-token-branch", branchId: "branch-1" },
          projectToken,
        ],
      ],
      [
        "REMOVE_ME",
        [
          { ...projectRemove, id: "env-remove-branch", branchId: "branch-1" },
          projectRemove,
        ],
      ],
    ]);

    const client = {
      listEnvironmentVariables: (query: { key: string }) => {
        calls.push(["list", query]);
        return Effect.succeed(byKey.get(query.key) ?? []);
      },
      createEnvironmentVariable: (input: unknown) => {
        calls.push(["create", input]);
        return Effect.succeed({
          id: "env-created",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-created",
          projectId: "project-1",
          branchId: null,
          class: "production" as const,
          key: "API_URL",
          valueKid: "kid-2",
          isManagedBySystem: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        });
      },
      updateEnvironmentVariable: (id: string, input: unknown) => {
        calls.push(["update", { id, input }]);
        return Effect.succeed(projectToken);
      },
      deleteEnvironmentVariable: (id: string) => {
        calls.push(["delete", id]);
        return Effect.void;
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const result = yield* syncComputeEnvironment(
        client,
        "project-1",
        "production",
        {
          API_URL: "https://example.test",
          TOKEN: Redacted.make("secret"),
          REMOVE_ME: null,
          SKIP_ME: undefined,
        },
      );

      expect(result).toEqual({
        synced: ["API_URL", "TOKEN"],
        deleted: ["REMOVE_ME"],
      });
      expect(calls).toEqual([
        [
          "list",
          {
            projectId: "project-1",
            class: "production",
            key: "API_URL",
            limit: 2,
          },
        ],
        [
          "create",
          {
            projectId: "project-1",
            class: "production",
            key: "API_URL",
            value: "https://example.test",
          },
        ],
        [
          "list",
          {
            projectId: "project-1",
            class: "production",
            key: "TOKEN",
            limit: 2,
          },
        ],
        ["update", { id: "env-token", input: { value: "secret" } }],
        [
          "list",
          {
            projectId: "project-1",
            class: "production",
            key: "REMOVE_ME",
            limit: 2,
          },
        ],
        ["delete", "env-remove"],
      ]);
    });
  });

  it.effect("refuses to sync system-managed Compute env vars", () => {
    const calls: Array<[string, unknown]> = [];
    const systemVariable = {
      id: "env-system",
      type: "environment-variable" as const,
      url: "https://api.prisma.test/v1/environment-variables/env-system",
      projectId: "project-1",
      branchId: null,
      class: "production" as const,
      key: "PRISMA_INTERNAL_URL",
      valueKid: "kid-system",
      isManagedBySystem: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const client = {
      listEnvironmentVariables: (query: unknown) => {
        calls.push(["list", query]);
        return Effect.succeed([systemVariable]);
      },
      updateEnvironmentVariable: (id: string, input: unknown) => {
        calls.push(["update", { id, input }]);
        return Effect.succeed(systemVariable);
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const error = yield* syncComputeEnvironment(
        client,
        "project-1",
        "production",
        {
          PRISMA_INTERNAL_URL: "secret",
        },
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "is managed by Prisma and cannot be managed by Alchemy",
      );
      expect(calls).toEqual([
        [
          "list",
          {
            projectId: "project-1",
            class: "production",
            key: "PRISMA_INTERNAL_URL",
            limit: 2,
          },
        ],
      ]);
    });
  });

  it.effect("validates Compute env vars before remote writes", () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      getComputeService: (id: string) =>
        Effect.sync(() => {
          calls.push(["getComputeService", id]);
          return {
            id,
            type: "compute-service" as const,
            url: "https://api.prisma.test/v1/compute-services/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: null,
            latestVersionId: null,
            serviceEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          };
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            serviceName: "api",
            artifact: "v1",
            env: {
              "bad-key": "secret",
            },
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "must match POSIX env-var key shape",
      );
      expect(calls).toEqual([]);
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("merges binding env into Compute deployment env", () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      getComputeService: (id: string) => {
        calls.push(["getComputeService", id]);
        return Effect.succeed({
          id,
          type: "compute-service" as const,
          url: "https://api.prisma.test/v1/compute-services/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: null,
          latestVersionId: null,
          serviceEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      listEnvironmentVariables: (query: unknown) => {
        calls.push(["listEnvironmentVariables", query]);
        return Effect.succeed([]);
      },
      createEnvironmentVariable: (input: unknown) => {
        calls.push(["createEnvironmentVariable", input]);
        return Effect.succeed({
          id: "env-created",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-created",
          projectId: "project-1",
          branchId: null,
          class: "production" as const,
          key: "DATABASE_URL",
          valueKid: "kid-created",
          isManagedBySystem: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        });
      },
      createServiceComputeVersion: (
        computeServiceId: string,
        input: unknown,
      ) => {
        calls.push([
          "createServiceComputeVersion",
          { computeServiceId, input },
        ]);
        return Effect.succeed({
          id: "version-1",
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: null,
        });
      },
      getComputeServiceVersion: (id: string) => {
        calls.push(["getComputeServiceVersion", id]);
        return Effect.succeed({
          id,
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-1",
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: "version-1.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          serviceName: "api",
          branchId: null,
          skipCodeUpload: true,
          start: false,
          skipPromote: true,
          envClass: "preview",
        },
        olds: undefined,
        output: {
          computeServiceId: "service-1",
          computeVersionId: undefined,
          projectId: "project-1",
          serviceName: "api",
          regionId: "us-east-1",
          versionEndpointDomain: undefined,
          versionUrl: undefined,
          serviceEndpointDomain: "api.prisma.build",
          url: "https://api.prisma.build",
          promoted: false,
          previousVersionId: undefined,
          previousVersionAction: undefined,
          artifactHash: undefined,
          local: false,
        },
        session: undefined as never,
        bindings: [
          {
            sid: "Connection",
            data: {
              env: {
                DATABASE_URL: Redacted.make("postgres://bound"),
                SHARED_FLAG: "from-binding",
              },
            },
          },
        ],
      });

      expect(output.computeVersionId).toBe("version-1");
      expect(output.environmentKeys).toEqual(["DATABASE_URL", "SHARED_FLAG"]);
      expect(output.environmentClass).toBe("preview");
      expect(calls).toContainEqual([
        "createEnvironmentVariable",
        {
          projectId: "project-1",
          class: "preview",
          key: "DATABASE_URL",
          value: "postgres://bound",
        },
      ]);
      expect(calls).toContainEqual([
        "createEnvironmentVariable",
        {
          projectId: "project-1",
          class: "preview",
          key: "SHARED_FLAG",
          value: "from-binding",
        },
      ]);
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "lets explicit Compute env override bindings and ignores deleted bindings",
    () => {
      const calls: Array<[string, unknown]> = [];
      const client = {
        getComputeService: (id: string) => {
          calls.push(["getComputeService", id]);
          return Effect.succeed({
            id,
            type: "compute-service" as const,
            url: "https://api.prisma.test/v1/compute-services/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: null,
            latestVersionId: null,
            serviceEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        listEnvironmentVariables: (query: unknown) => {
          calls.push(["listEnvironmentVariables", query]);
          return Effect.succeed([]);
        },
        createEnvironmentVariable: (input: {
          key: string;
          projectId: string;
          class: "production" | "preview";
        }) => {
          calls.push(["createEnvironmentVariable", input]);
          return Effect.succeed({
            id: `env-${input.key.toLowerCase()}`,
            type: "environment-variable" as const,
            url: `https://api.prisma.test/v1/environment-variables/env-${input.key.toLowerCase()}`,
            projectId: input.projectId,
            branchId: null,
            class: input.class,
            key: input.key,
            valueKid: `kid-${input.key.toLowerCase()}`,
            isManagedBySystem: false,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          });
        },
        createServiceComputeVersion: (
          computeServiceId: string,
          input: unknown,
        ) => {
          calls.push([
            "createServiceComputeVersion",
            { computeServiceId, input },
          ]);
          return Effect.succeed({
            id: "version-1",
            type: "compute-version" as const,
            url: "https://api.prisma.test/v1/versions/version-1",
            foundryVersionId: "foundry-1",
            uploadUrl: null,
          });
        },
        getComputeServiceVersion: (id: string) => {
          calls.push(["getComputeServiceVersion", id]);
          return Effect.succeed({
            id,
            type: "compute-version" as const,
            url: "https://api.prisma.test/v1/versions/version-1",
            foundryVersionId: "foundry-1",
            status: "new",
            previewDomain: "version-1.preview.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const deletedBinding = {
          sid: "RemovedConnection",
          action: "delete",
          data: {
            env: {
              DELETED_BINDING: "must-not-sync",
            },
          },
        } as ResourceBinding<Compute["Binding"]> & { action: "delete" };
        const output = yield* provider.reconcile({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            serviceName: "api",
            branchId: null,
            skipCodeUpload: true,
            start: false,
            skipPromote: true,
            env: {
              DATABASE_URL: Redacted.make("postgres://explicit"),
              BOUND_ONLY: null,
            },
          },
          olds: undefined,
          output: {
            computeServiceId: "service-1",
            computeVersionId: undefined,
            projectId: "project-1",
            serviceName: "api",
            regionId: "us-east-1",
            versionEndpointDomain: undefined,
            versionUrl: undefined,
            serviceEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: false,
            previousVersionId: undefined,
            previousVersionAction: undefined,
            artifactHash: undefined,
            local: false,
          },
          session: undefined as never,
          bindings: [
            {
              sid: "Connection",
              data: {
                env: {
                  DATABASE_URL: Redacted.make("postgres://bound"),
                  BOUND_ONLY: "from-binding",
                  ACTIVE_BINDING: "from-active-binding",
                },
              },
            },
            deletedBinding,
          ],
        });

        expect(output.environmentKeys).toEqual([
          "ACTIVE_BINDING",
          "DATABASE_URL",
        ]);
        expect(calls).toContainEqual([
          "createEnvironmentVariable",
          {
            projectId: "project-1",
            class: "production",
            key: "DATABASE_URL",
            value: "postgres://explicit",
          },
        ]);
        expect(calls).toContainEqual([
          "createEnvironmentVariable",
          {
            projectId: "project-1",
            class: "production",
            key: "ACTIVE_BINDING",
            value: "from-active-binding",
          },
        ]);
        expect(calls).not.toContainEqual([
          "createEnvironmentVariable",
          {
            projectId: "project-1",
            class: "production",
            key: "DELETED_BINDING",
            value: "must-not-sync",
          },
        ]);
        expect(calls).not.toContainEqual([
          "createEnvironmentVariable",
          {
            projectId: "project-1",
            class: "production",
            key: "BOUND_ONLY",
            value: "from-binding",
          },
        ]);
      }).pipe(
        Effect.provide(ComputeProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("removes env vars from previously managed bindings", () => {
    const calls: Array<[string, unknown]> = [];
    const byKey = new Map([
      [
        "OLD_BOUND_FLAG",
        {
          id: "env-old-bound-flag",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-old-bound-flag",
          projectId: "project-1",
          branchId: null,
          class: "production" as const,
          key: "OLD_BOUND_FLAG",
          valueKid: "kid-old",
          isManagedBySystem: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    ]);
    const client = {
      getComputeService: (id: string) => {
        calls.push(["getComputeService", id]);
        return Effect.succeed({
          id,
          type: "compute-service" as const,
          url: "https://api.prisma.test/v1/compute-services/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: null,
          latestVersionId: null,
          serviceEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      listEnvironmentVariables: (query: { key: string }) => {
        calls.push(["listEnvironmentVariables", query]);
        return Effect.succeed(
          byKey.get(query.key) ? [byKey.get(query.key)] : [],
        );
      },
      createEnvironmentVariable: (input: unknown) => {
        calls.push(["createEnvironmentVariable", input]);
        return Effect.succeed({
          id: "env-created",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-created",
          projectId: "project-1",
          branchId: null,
          class: "production" as const,
          key: "DATABASE_URL",
          valueKid: "kid-created",
          isManagedBySystem: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        });
      },
      deleteEnvironmentVariable: (id: string) => {
        calls.push(["deleteEnvironmentVariable", id]);
        return Effect.void;
      },
      createServiceComputeVersion: (
        computeServiceId: string,
        input: unknown,
      ) => {
        calls.push([
          "createServiceComputeVersion",
          { computeServiceId, input },
        ]);
        return Effect.succeed({
          id: "version-1",
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: null,
        });
      },
      getComputeServiceVersion: (id: string) => {
        calls.push(["getComputeServiceVersion", id]);
        return Effect.succeed({
          id,
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-1",
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: "version-1.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          serviceName: "api",
          branchId: null,
          skipCodeUpload: true,
          start: false,
          skipPromote: true,
        },
        olds: undefined,
        output: {
          computeServiceId: "service-1",
          computeVersionId: undefined,
          projectId: "project-1",
          serviceName: "api",
          regionId: "us-east-1",
          versionEndpointDomain: undefined,
          versionUrl: undefined,
          serviceEndpointDomain: "api.prisma.build",
          url: "https://api.prisma.build",
          promoted: false,
          previousVersionId: undefined,
          previousVersionAction: undefined,
          environmentKeys: ["DATABASE_URL", "OLD_BOUND_FLAG"],
          artifactHash: undefined,
          local: false,
        },
        session: undefined as never,
        bindings: [
          {
            sid: "Connection",
            data: {
              env: {
                DATABASE_URL: Redacted.make("postgres://still-bound"),
              },
            },
          },
        ],
      });

      expect(output.environmentKeys).toEqual(["DATABASE_URL"]);
      expect(calls).toContainEqual([
        "deleteEnvironmentVariable",
        "env-old-bound-flag",
      ]);
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("does not expose redacted env values in Compute outputs", () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      getComputeService: (id: string) => {
        calls.push(["getComputeService", id]);
        return Effect.succeed({
          id,
          type: "compute-service" as const,
          url: "https://api.prisma.test/v1/compute-services/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: "branch-main",
          latestVersionId: null,
          serviceEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      listEnvironmentVariables: (query: unknown) => {
        calls.push(["listEnvironmentVariables", query]);
        return Effect.succeed([]);
      },
      createEnvironmentVariable: (input: unknown) => {
        calls.push(["createEnvironmentVariable", input]);
        return Effect.succeed({
          id: "env-secret",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-secret",
          projectId: "project-1",
          branchId: null,
          class: "production" as const,
          key: "SECRET",
          valueKid: "kid-secret",
          isManagedBySystem: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        });
      },
      createServiceComputeVersion: (
        computeServiceId: string,
        input: unknown,
      ) => {
        calls.push([
          "createServiceComputeVersion",
          { computeServiceId, input },
        ]);
        return Effect.succeed({
          id: "version-new",
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-new",
          foundryVersionId: "foundry-new",
          uploadUrl: null,
        });
      },
      getComputeServiceVersion: (id: string) => {
        calls.push(["getComputeServiceVersion", id]);
        return Effect.succeed({
          id,
          type: "compute-version" as const,
          url: `https://api.prisma.test/v1/versions/${id}`,
          foundryVersionId: "foundry-new",
          status: "new",
          previewDomain: "version-new.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          serviceName: "api",
          branchId: "branch-main",
          skipCodeUpload: true,
          start: false,
          skipPromote: true,
          env: {
            SECRET: Redacted.make("super-secret"),
          },
        },
        olds: undefined,
        output: {
          computeServiceId: "service-1",
          computeVersionId: "version-old",
          projectId: "project-1",
          serviceName: "api",
          regionId: "us-east-1",
          versionEndpointDomain: "version-old.preview.prisma.build",
          versionUrl: "https://version-old.preview.prisma.build",
          serviceEndpointDomain: "api.prisma.build",
          url: "https://api.prisma.build",
          promoted: true,
          previousVersionId: undefined,
          previousVersionAction: undefined,
          artifactHash: "old-hash",
          local: false,
        },
        session: undefined as never,
        bindings: [],
      });

      expect(output.computeVersionId).toBe("version-new");
      expect(output.artifactHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(output)).not.toContain("super-secret");
      expect(calls).toContainEqual([
        "createEnvironmentVariable",
        {
          projectId: "project-1",
          class: "production",
          key: "SECRET",
          value: "super-secret",
        },
      ]);
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("runs a build command and uploads the built archive", () => {
    const calls: Array<[string, unknown]> = [];
    let uploaded:
      | { url: string; contentType: string | undefined; bytes: Uint8Array }
      | undefined;
    const client = {
      listProjectComputeServices: (projectId: string, query: unknown) => {
        calls.push(["listProjectComputeServices", { projectId, query }]);
        return Effect.succeed([]);
      },
      createProjectComputeService: (projectId: string, input: unknown) => {
        calls.push(["createProjectComputeService", { projectId, input }]);
        return Effect.succeed({
          id: "service-1",
          type: "compute-service" as const,
          url: "https://api.prisma.test/v1/compute-services/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId,
          branchId: "branch-main",
          latestVersionId: null,
          serviceEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      updateComputeService: (id: string, input: unknown) => {
        calls.push(["updateComputeService", { id, input }]);
        return Effect.succeed({
          id,
          type: "compute-service" as const,
          url: "https://api.prisma.test/v1/compute-services/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: "branch-main",
          latestVersionId: null,
          serviceEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      listEnvironmentVariables: () => Effect.succeed([]),
      createServiceComputeVersion: (
        computeServiceId: string,
        input: unknown,
      ) => {
        calls.push([
          "createServiceComputeVersion",
          { computeServiceId, input },
        ]);
        return Effect.succeed({
          id: "version-1",
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: "https://upload.prisma.test/artifact.tar.gz",
        });
      },
      getComputeServiceVersion: (id: string) => {
        calls.push(["getComputeServiceVersion", id]);
        return Effect.succeed({
          id,
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-1",
          foundryVersionId: "foundry-1",
          status: "running",
          previewDomain: "version-1.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      promoteComputeService: (computeServiceId: string, versionId: string) => {
        calls.push(["promoteComputeService", { computeServiceId, versionId }]);
        return Effect.succeed({ serviceEndpointDomain: "api.prisma.build" });
      },
    } as unknown as PrismaManagementClient;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const body = request.body as HttpBody.HttpBody;
        uploaded = {
          url: request.url,
          contentType:
            body._tag === "Uint8Array" ? body.contentType : undefined,
          bytes: body._tag === "Uint8Array" ? body.body : new Uint8Array(),
        };
        return HttpClientResponse.fromWeb(request, new Response(null));
      }),
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-build-",
      });
      yield* fs.writeFileString(
        path.join(root, "build.sh"),
        [
          "mkdir -p dist",
          'printf \'console.log("%s");\' "$BUILD_GREETING" > dist/server.js',
          "",
        ].join("\n"),
      );

      const provider = yield* Compute.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          serviceName: "api",
          path: root,
          port: 4567,
          verifyUrl: false,
          build: {
            command: "sh build.sh",
            cwd: root,
            outdir: "dist",
            entrypoint: "server.js",
            env: { BUILD_GREETING: "hello-build" },
          },
        },
        olds: undefined,
        output: undefined,
        session: undefined as never,
        bindings: [],
      });

      expect(output.computeVersionId).toBe("version-1");
      expect(uploaded?.url).toBe("https://upload.prisma.test/artifact.tar.gz");
      expect(uploaded?.contentType).toBe("application/gzip");
      const tarText = new TextDecoder().decode(
        yield* Effect.sync(() => gunzipSync(uploaded!.bytes)),
      );
      expect(tarText).toContain("compute.manifest.json");
      expect(tarText).toContain("bundle/server.js");
      expect(tarText).toContain("hello-build");
      expect(calls).toContainEqual([
        "createServiceComputeVersion",
        {
          computeServiceId: "service-1",
          input: {
            portMapping: { http: 4567 },
            skipCodeUpload: undefined,
          },
        },
      ]);
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("auto-builds a Bun app before uploading", () => {
    const calls: Array<[string, unknown]> = [];
    let uploaded:
      | { url: string; contentType: string | undefined; bytes: Uint8Array }
      | undefined;
    const client = {
      listProjectComputeServices: (projectId: string, query: unknown) => {
        calls.push(["listProjectComputeServices", { projectId, query }]);
        return Effect.succeed([]);
      },
      createProjectComputeService: (projectId: string, input: unknown) => {
        calls.push(["createProjectComputeService", { projectId, input }]);
        return Effect.succeed({
          id: "service-1",
          type: "compute-service" as const,
          url: "https://api.prisma.test/v1/compute-services/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId,
          branchId: "branch-main",
          latestVersionId: null,
          serviceEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      listEnvironmentVariables: () => Effect.succeed([]),
      createServiceComputeVersion: (
        computeServiceId: string,
        input: unknown,
      ) => {
        calls.push([
          "createServiceComputeVersion",
          { computeServiceId, input },
        ]);
        return Effect.succeed({
          id: "version-1",
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: "https://upload.prisma.test/auto.tar.gz",
        });
      },
      getComputeServiceVersion: (id: string) => {
        calls.push(["getComputeServiceVersion", id]);
        return Effect.succeed({
          id,
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-1",
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: "version-1.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
    } as unknown as PrismaManagementClient;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const body = request.body as HttpBody.HttpBody;
        uploaded = {
          url: request.url,
          contentType:
            body._tag === "Uint8Array" ? body.contentType : undefined,
          bytes: body._tag === "Uint8Array" ? body.body : new Uint8Array(),
        };
        return HttpClientResponse.fromWeb(request, new Response(null));
      }),
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-auto-",
      });
      yield* fs.makeDirectory(path.join(root, "src"));
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ main: "src/server.ts" }),
      );
      yield* fs.writeFileString(
        path.join(root, "src", "server.ts"),
        "console.log('auto app');",
      );

      const provider = yield* Compute.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          serviceName: "api",
          path: root,
          build: "auto",
          start: false,
          skipPromote: true,
        },
        olds: undefined,
        output: undefined,
        session: undefined as never,
        bindings: [],
      });

      expect(output.computeVersionId).toBe("version-1");
      expect(uploaded?.url).toBe("https://upload.prisma.test/auto.tar.gz");
      expect(uploaded?.contentType).toBe("application/gzip");
      const tarText = new TextDecoder().decode(
        yield* Effect.sync(() => gunzipSync(uploaded!.bytes)),
      );
      expect(tarText).toContain("bundle/server.js");
      expect(tarText).toContain("auto app");
      expect(calls).toContainEqual([
        "createServiceComputeVersion",
        {
          computeServiceId: "service-1",
          input: {
            portMapping: { http: 8080 },
            skipCodeUpload: undefined,
          },
        },
      ]);
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("uses framework auto-build default ports in Compute", () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      listProjectComputeServices: (projectId: string, query: unknown) => {
        calls.push(["listProjectComputeServices", { projectId, query }]);
        return Effect.succeed([]);
      },
      createProjectComputeService: (projectId: string, input: unknown) => {
        calls.push(["createProjectComputeService", { projectId, input }]);
        return Effect.succeed({
          id: "service-1",
          type: "compute-service" as const,
          url: "https://api.prisma.test/v1/compute-services/service-1",
          name: "web",
          region: { id: "us-east-1", name: "US East" },
          projectId,
          branchId: "branch-main",
          latestVersionId: null,
          serviceEndpointDomain: "web.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      listEnvironmentVariables: () => Effect.succeed([]),
      createServiceComputeVersion: (
        computeServiceId: string,
        input: unknown,
      ) => {
        calls.push([
          "createServiceComputeVersion",
          { computeServiceId, input },
        ]);
        return Effect.succeed({
          id: "version-1",
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: "https://upload.prisma.test/next.tar.gz",
        });
      },
      getComputeServiceVersion: (id: string) => {
        calls.push(["getComputeServiceVersion", id]);
        return Effect.succeed({
          id,
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-1",
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: "version-1.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
    } as unknown as PrismaManagementClient;
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null))),
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-auto-next-",
      });
      const binDir = path.join(root, "node_modules", ".bin");
      const nextBin = path.join(binDir, "next");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
      );
      yield* fs.writeFileString(
        nextBin,
        [
          "#!/bin/sh",
          "mkdir -p .next/standalone",
          "printf 'next server' > .next/standalone/server.js",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(nextBin, 0o755);

      const provider = yield* Compute.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          serviceName: "web",
          path: root,
          build: { type: "auto", framework: "nextjs" },
          start: false,
          skipPromote: true,
        },
        olds: undefined,
        output: undefined,
        session: undefined as never,
        bindings: [],
      });

      expect(output.computeVersionId).toBe("version-1");
      expect(calls).toContainEqual([
        "createServiceComputeVersion",
        {
          computeServiceId: "service-1",
          input: {
            portMapping: { http: 3000 },
            skipCodeUpload: undefined,
          },
        },
      ]);
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "continues when compute service create races with an existing service",
    () => {
      const calls: Array<[string, unknown]> = [];
      let serviceListCount = 0;
      const service = {
        id: "service-1",
        type: "compute-service" as const,
        url: "https://api.prisma.test/v1/compute-services/service-1",
        name: "api",
        region: { id: "us-east-1", name: "US East" },
        projectId: "project-1",
        branchId: "branch-main",
        latestVersionId: null,
        serviceEndpointDomain: "api.prisma.build",
        createdAt: "2026-01-01T00:00:00Z",
      };

      const client = {
        listProjectComputeServices: (projectId: string, query: unknown) =>
          Effect.sync(() => {
            serviceListCount += 1;
            calls.push(["listProjectComputeServices", { projectId, query }]);
            return serviceListCount === 1 ? [] : [service];
          }),
        createProjectComputeService: (projectId: string, input: unknown) =>
          Effect.gen(function* () {
            calls.push(["createProjectComputeService", { projectId, input }]);
            return yield* Effect.fail(
              new PrismaApiError({
                method: "POST",
                path: `/v1/projects/${projectId}/compute-services`,
                status: 409,
                message: "already exists",
              }),
            );
          }),
        listBranches: (projectId: string, query: unknown) => {
          calls.push(["listBranches", { projectId, query }]);
          return Effect.succeed([
            {
              id: "branch-main",
              type: "branch" as const,
              url: "https://api.prisma.test/v1/branches/branch-main",
              gitName: "main",
              isDefault: true,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              project: {
                id: "project-1",
                url: "https://api.prisma.test/v1/projects/project-1",
                name: "project",
              },
            },
          ]);
        },
        updateComputeService: (id: string, input: unknown) => {
          calls.push(["updateComputeService", { id, input }]);
          return Effect.succeed(service);
        },
        listEnvironmentVariables: (query: unknown) => {
          calls.push(["listEnvironmentVariables", query]);
          return Effect.succeed([]);
        },
        createServiceComputeVersion: (
          computeServiceId: string,
          input: unknown,
        ) => {
          calls.push([
            "createServiceComputeVersion",
            { computeServiceId, input },
          ]);
          return Effect.succeed({
            id: "version-1",
            type: "compute-version" as const,
            url: "https://api.prisma.test/v1/versions/version-1",
            foundryVersionId: "foundry-1",
            uploadUrl: null,
          });
        },
        getComputeServiceVersion: (id: string) => {
          calls.push(["getComputeServiceVersion", id]);
          return Effect.succeed({
            id,
            type: "compute-version" as const,
            url: "https://api.prisma.test/v1/versions/version-1",
            foundryVersionId: "foundry-1",
            status: "new",
            previewDomain: null,
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const output = yield* provider.reconcile({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            serviceName: "api",
            skipCodeUpload: true,
            start: false,
            skipPromote: true,
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        });

        expect(output.computeServiceId).toBe("service-1");
        expect(output.computeVersionId).toBe("version-1");
        expect(calls).toEqual([
          [
            "listProjectComputeServices",
            { projectId: "project-1", query: { limit: 100 } },
          ],
          [
            "createProjectComputeService",
            {
              projectId: "project-1",
              input: {
                displayName: "api",
                regionId: "us-east-1",
                branchId: undefined,
                branchGitName: "main",
              },
            },
          ],
          [
            "listProjectComputeServices",
            { projectId: "project-1", query: { limit: 100 } },
          ],
          [
            "listBranches",
            {
              projectId: "project-1",
              query: { gitName: "main", limit: 1 },
            },
          ],
          [
            "createServiceComputeVersion",
            {
              computeServiceId: "service-1",
              input: { portMapping: { http: 8080 }, skipCodeUpload: true },
            },
          ],
          ["getComputeServiceVersion", "version-1"],
        ]);
      }).pipe(
        Effect.provide(ComputeProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect(
    "reconciles deploy updates and destroys old compute versions",
    () => {
      const calls: Array<[string, unknown]> = [];
      const versions = new Map<string, "new" | "running" | "stopped">();
      let latestVersionId: string | null = null;
      let versionCounter = 0;

      const service = () => ({
        id: "service-1",
        type: "compute-service" as const,
        url: "https://api.prisma.test/v1/compute-services/service-1",
        name: "api",
        region: { id: "us-east-1", name: "US East" },
        projectId: "project-1",
        branchId: "branch-main",
        latestVersionId,
        serviceEndpointDomain: "api.prisma.build",
        createdAt: "2026-01-01T00:00:00Z",
      });

      const version = (id: string) => ({
        id,
        type: "compute-version" as const,
        url: `https://api.prisma.test/v1/versions/${id}`,
        foundryVersionId: `foundry-${id}`,
        status: versions.get(id) ?? "new",
        previewDomain: `${id}.preview.prisma.build`,
        createdAt: "2026-01-01T00:00:00Z",
      });

      const client = {
        listProjectComputeServices: (projectId: string, query: unknown) => {
          calls.push(["listProjectComputeServices", { projectId, query }]);
          return Effect.succeed([]);
        },
        getComputeService: (id: string) => {
          calls.push(["getComputeService", id]);
          return Effect.succeed(service());
        },
        listBranches: (projectId: string, query: unknown) => {
          calls.push(["listBranches", { projectId, query }]);
          return Effect.succeed([
            {
              id: "branch-main",
              type: "branch" as const,
              url: "https://api.prisma.test/v1/branches/branch-main",
              gitName: "main",
              isDefault: true,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              project: {
                id: "project-1",
                url: "https://api.prisma.test/v1/projects/project-1",
                name: "project",
              },
            },
          ]);
        },
        createProjectComputeService: (projectId: string, input: unknown) => {
          calls.push(["createProjectComputeService", { projectId, input }]);
          return Effect.succeed(service());
        },
        updateComputeService: (id: string, input: unknown) => {
          calls.push(["updateComputeService", { id, input }]);
          return Effect.succeed(service());
        },
        listEnvironmentVariables: (query: unknown) => {
          calls.push(["listEnvironmentVariables", query]);
          return Effect.succeed([]);
        },
        createServiceComputeVersion: (
          computeServiceId: string,
          input: unknown,
        ) =>
          Effect.sync(() => {
            const id = `version-${++versionCounter}`;
            calls.push([
              "createServiceComputeVersion",
              { computeServiceId, input },
            ]);
            versions.set(id, "new");
            return {
              id,
              type: "compute-version" as const,
              url: `https://api.prisma.test/v1/versions/${id}`,
              foundryVersionId: `foundry-${id}`,
              uploadUrl: `https://upload.prisma.test/${id}.tar.gz`,
            };
          }),
        getComputeServiceVersion: (id: string) => {
          calls.push(["getComputeServiceVersion", id]);
          return Effect.succeed(version(id));
        },
        startComputeServiceVersion: (id: string) =>
          Effect.sync(() => {
            calls.push(["startComputeServiceVersion", id]);
            versions.set(id, "running");
            return { previewDomain: `${id}.preview.prisma.build` };
          }),
        promoteComputeService: (computeServiceId: string, versionId: string) =>
          Effect.sync(() => {
            calls.push([
              "promoteComputeService",
              { computeServiceId, versionId },
            ]);
            latestVersionId = versionId;
            return { serviceEndpointDomain: "api.prisma.build" };
          }),
        stopComputeServiceVersion: (id: string) =>
          Effect.sync(() => {
            calls.push(["stopComputeServiceVersion", id]);
            versions.set(id, "stopped");
          }),
        deleteComputeServiceVersion: (id: string) =>
          Effect.sync(() => {
            calls.push(["deleteComputeServiceVersion", id]);
            versions.delete(id);
          }),
        listServiceComputeVersions: (
          computeServiceId: string,
          query: unknown,
        ) => {
          calls.push([
            "listServiceComputeVersions",
            { computeServiceId, query },
          ]);
          return Effect.succeed(
            [...versions.keys()].map((id) => ({
              id,
              type: "compute-version" as const,
              url: `https://api.prisma.test/v1/versions/${id}`,
              foundryVersionId: `foundry-${id}`,
              createdAt: "2026-01-01T00:00:00Z",
            })),
          );
        },
        deleteComputeService: (id: string) =>
          Effect.sync(() => {
            calls.push(["deleteComputeService", id]);
          }),
      } as unknown as PrismaManagementClient;

      const http = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null))),
      );

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const first = yield* provider.reconcile({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            serviceName: "api",
            artifact: "v1",
            port: 3000,
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        });

        const second = yield* provider.reconcile({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            serviceName: "api",
            artifact: "v2",
            port: 3000,
            destroyOldVersion: true,
          },
          olds: {
            project: "project-1",
            serviceName: "api",
            artifact: "v1",
            port: 3000,
          },
          output: first,
          session: undefined as never,
          bindings: [],
        });

        yield* provider.delete({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          olds: {
            project: "project-1",
            serviceName: "api",
            artifact: "v2",
            port: 3000,
          },
          output: second,
          session: undefined as never,
          bindings: [],
        });

        expect(first.computeVersionId).toBe("version-1");
        expect(first.promoted).toBe(true);
        expect(second.computeVersionId).toBe("version-2");
        expect(second.previousVersionId).toBe("version-1");
        expect(second.previousVersionAction).toBe("destroyed");
        expect(versions.size).toBe(0);
        expect(calls).toEqual([
          [
            "listProjectComputeServices",
            { projectId: "project-1", query: { limit: 100 } },
          ],
          [
            "createProjectComputeService",
            {
              projectId: "project-1",
              input: {
                displayName: "api",
                regionId: "us-east-1",
                branchId: undefined,
                branchGitName: "main",
              },
            },
          ],
          [
            "createServiceComputeVersion",
            {
              computeServiceId: "service-1",
              input: {
                portMapping: { http: 3000 },
                skipCodeUpload: undefined,
              },
            },
          ],
          ["getComputeServiceVersion", "version-1"],
          ["startComputeServiceVersion", "version-1"],
          ["getComputeServiceVersion", "version-1"],
          [
            "promoteComputeService",
            { computeServiceId: "service-1", versionId: "version-1" },
          ],
          ["getComputeService", "service-1"],
          [
            "listBranches",
            { projectId: "project-1", query: { gitName: "main", limit: 1 } },
          ],
          [
            "createServiceComputeVersion",
            {
              computeServiceId: "service-1",
              input: {
                portMapping: { http: 3000 },
                skipCodeUpload: undefined,
              },
            },
          ],
          ["getComputeServiceVersion", "version-2"],
          ["startComputeServiceVersion", "version-2"],
          ["getComputeServiceVersion", "version-2"],
          [
            "promoteComputeService",
            { computeServiceId: "service-1", versionId: "version-2" },
          ],
          ["stopComputeServiceVersion", "version-1"],
          ["getComputeServiceVersion", "version-1"],
          ["getComputeServiceVersion", "version-1"],
          ["deleteComputeServiceVersion", "version-1"],
          [
            "listServiceComputeVersions",
            { computeServiceId: "service-1", query: { limit: 100 } },
          ],
          ["getComputeServiceVersion", "version-2"],
          ["stopComputeServiceVersion", "version-2"],
          ["getComputeServiceVersion", "version-2"],
          ["deleteComputeServiceVersion", "version-2"],
          ["deleteComputeService", "service-1"],
        ]);
      }).pipe(
        Effect.provide(ComputeProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
        Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect(
    "creates a no-upload version for skipCodeUpload env updates",
    () => {
      const calls: Array<[string, unknown]> = [];
      const featureEnv = {
        id: "env-feature",
        type: "environment-variable" as const,
        url: "https://api.prisma.test/v1/environment-variables/env-feature",
        projectId: "project-1",
        branchId: null,
        class: "production" as const,
        key: "FEATURE",
        valueKid: "kid-feature",
        isManagedBySystem: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      const client = {
        getComputeService: (id: string) => {
          calls.push(["getComputeService", id]);
          return Effect.succeed({
            id,
            type: "compute-service" as const,
            url: "https://api.prisma.test/v1/compute-services/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: "branch-main",
            latestVersionId: "version-old",
            serviceEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        listEnvironmentVariables: (query: { key: string }) => {
          calls.push(["listEnvironmentVariables", query]);
          return Effect.succeed(query.key === "FEATURE" ? [featureEnv] : []);
        },
        updateEnvironmentVariable: (id: string, input: unknown) => {
          calls.push(["updateEnvironmentVariable", { id, input }]);
          return Effect.succeed(featureEnv);
        },
        createServiceComputeVersion: (
          computeServiceId: string,
          input: unknown,
        ) => {
          calls.push([
            "createServiceComputeVersion",
            { computeServiceId, input },
          ]);
          return Effect.succeed({
            id: "version-new",
            type: "compute-version" as const,
            url: "https://api.prisma.test/v1/versions/version-new",
            foundryVersionId: "foundry-new",
            uploadUrl: null,
          });
        },
        getComputeServiceVersion: (id: string) => {
          calls.push(["getComputeServiceVersion", id]);
          return Effect.succeed({
            id,
            type: "compute-version" as const,
            url: `https://api.prisma.test/v1/versions/${id}`,
            foundryVersionId: "foundry-new",
            status: "new",
            previewDomain: "version-new.preview.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const output = yield* provider.reconcile({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            serviceName: "api",
            branchId: "branch-main",
            skipCodeUpload: true,
            start: false,
            skipPromote: true,
            env: {
              FEATURE: "on",
            },
          },
          olds: {
            project: "project-1",
            serviceName: "api",
            branchId: "branch-main",
            skipCodeUpload: true,
            start: false,
            skipPromote: true,
            env: {
              FEATURE: "off",
            },
          },
          output: {
            computeServiceId: "service-1",
            computeVersionId: "version-old",
            projectId: "project-1",
            serviceName: "api",
            regionId: "us-east-1",
            versionEndpointDomain: "version-old.preview.prisma.build",
            versionUrl: "https://version-old.preview.prisma.build",
            serviceEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: true,
            previousVersionId: undefined,
            previousVersionAction: undefined,
            artifactHash: "old-hash",
            local: false,
          },
          session: undefined as never,
          bindings: [],
        });

        expect(output.computeVersionId).toBe("version-new");
        expect(output.previousVersionId).toBe("version-old");
        expect(output.previousVersionAction).toBe("still-active");
        expect(calls).toEqual([
          ["getComputeService", "service-1"],
          [
            "listEnvironmentVariables",
            {
              projectId: "project-1",
              class: "production",
              key: "FEATURE",
              limit: 2,
            },
          ],
          [
            "updateEnvironmentVariable",
            { id: "env-feature", input: { value: "on" } },
          ],
          [
            "createServiceComputeVersion",
            {
              computeServiceId: "service-1",
              input: { portMapping: { http: 8080 }, skipCodeUpload: true },
            },
          ],
          ["getComputeServiceVersion", "version-new"],
        ]);
      }).pipe(
        Effect.provide(ComputeProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect(
    "does not re-promote an already promoted matching Compute version",
    () => {
      const calls: Array<[string, unknown]> = [];
      let latestVersionId: string | null = null;

      const service = () => ({
        id: "service-1",
        type: "compute-service" as const,
        url: "https://api.prisma.test/v1/compute-services/service-1",
        name: "api",
        region: { id: "us-east-1", name: "US East" },
        projectId: "project-1",
        branchId: null,
        latestVersionId,
        serviceEndpointDomain: "api.prisma.build",
        createdAt: "2026-01-01T00:00:00Z",
      });

      const client = {
        listProjectComputeServices: (projectId: string, query: unknown) => {
          calls.push(["listProjectComputeServices", { projectId, query }]);
          return Effect.succeed([]);
        },
        createProjectComputeService: (projectId: string, input: unknown) => {
          calls.push(["createProjectComputeService", { projectId, input }]);
          return Effect.succeed(service());
        },
        getComputeService: (id: string) => {
          calls.push(["getComputeService", id]);
          return Effect.succeed(service());
        },
        createServiceComputeVersion: (
          computeServiceId: string,
          input: unknown,
        ) => {
          calls.push([
            "createServiceComputeVersion",
            { computeServiceId, input },
          ]);
          return Effect.succeed({
            id: "version-1",
            type: "compute-version" as const,
            url: "https://api.prisma.test/v1/versions/version-1",
            foundryVersionId: "foundry-1",
            uploadUrl: null,
          });
        },
        getComputeServiceVersion: (id: string) => {
          calls.push(["getComputeServiceVersion", id]);
          return Effect.succeed({
            id,
            type: "compute-version" as const,
            url: `https://api.prisma.test/v1/versions/${id}`,
            foundryVersionId: "foundry-1",
            status: "running",
            previewDomain: "version-1.preview.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        promoteComputeService: (computeServiceId: string, versionId: string) =>
          Effect.sync(() => {
            calls.push([
              "promoteComputeService",
              { computeServiceId, versionId },
            ]);
            latestVersionId = versionId;
            return { serviceEndpointDomain: "api.prisma.build" };
          }),
      } as unknown as PrismaManagementClient;

      const news = {
        project: "project-1",
        serviceName: "api",
        branchId: null,
        skipCodeUpload: true,
        verifyUrl: false,
      };

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const first = yield* provider.reconcile({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          news,
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        });

        const second = yield* provider.reconcile({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          news,
          olds: news,
          output: first,
          session: undefined as never,
          bindings: [],
        });

        expect(first.computeVersionId).toBe("version-1");
        expect(second.computeVersionId).toBe("version-1");
        expect(second.previousVersionId).toBe("version-1");
        expect(
          calls.filter(([name]) => name === "promoteComputeService"),
        ).toEqual([
          [
            "promoteComputeService",
            { computeServiceId: "service-1", versionId: "version-1" },
          ],
        ]);
        expect(
          calls.filter(([name]) => name === "createServiceComputeVersion"),
        ).toHaveLength(1);
      }).pipe(
        Effect.provide(ComputeProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect(
    "surfaces platform cleanup context when destroying old version fails",
    () => {
      const calls: Array<[string, unknown]> = [];
      const client = {
        getComputeService: (id: string) => {
          calls.push(["getComputeService", id]);
          return Effect.succeed({
            id,
            type: "compute-service" as const,
            url: `https://api.prisma.test/v1/compute-services/${id}`,
            name: "api",
            region: { id: "us-east-1", name: "us-east-1" },
            projectId: "project-1",
            branchId: "branch-main",
            latestVersionId: "version-1",
            serviceEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        listBranches: (projectId: string, query: unknown) => {
          calls.push(["listBranches", { projectId, query }]);
          return Effect.succeed([
            {
              id: "branch-main",
              type: "branch" as const,
              url: "https://api.prisma.test/v1/branches/branch-main",
              gitName: "main",
              isDefault: true,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              project: {
                id: "project-1",
                url: "https://api.prisma.test/v1/projects/project-1",
                name: "project",
              },
            },
          ]);
        },
        createServiceComputeVersion: (
          computeServiceId: string,
          input: unknown,
        ) => {
          calls.push([
            "createServiceComputeVersion",
            { computeServiceId, input },
          ]);
          return Effect.succeed({
            id: "version-2",
            type: "compute-version" as const,
            url: "https://api.prisma.test/v1/versions/version-2",
            foundryVersionId: "foundry-version-2",
            uploadUrl: "https://upload.prisma.test/version-2.tar.gz",
          });
        },
        getComputeServiceVersion: (id: string) => {
          calls.push(["getComputeServiceVersion", id]);
          return Effect.succeed({
            id,
            type: "compute-version" as const,
            url: `https://api.prisma.test/v1/versions/${id}`,
            foundryVersionId: `foundry-${id}`,
            status: id === "version-1" ? "stopped" : "running",
            previewDomain: `${id}.preview.prisma.build`,
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        startComputeServiceVersion: (id: string) =>
          Effect.sync(() => {
            calls.push(["startComputeServiceVersion", id]);
            return { previewDomain: `${id}.preview.prisma.build` };
          }),
        promoteComputeService: (computeServiceId: string, versionId: string) =>
          Effect.sync(() => {
            calls.push([
              "promoteComputeService",
              { computeServiceId, versionId },
            ]);
            return { serviceEndpointDomain: "api.prisma.build" };
          }),
        stopComputeServiceVersion: (id: string) =>
          Effect.sync(() => {
            calls.push(["stopComputeServiceVersion", id]);
          }),
        deleteComputeServiceVersion: (id: string) =>
          Effect.gen(function* () {
            calls.push(["deleteComputeServiceVersion", id]);
            return yield* Effect.fail(
              new PrismaApiError({
                method: "DELETE",
                path: `/v1/compute-services/versions/${id}`,
                status: 500,
                message: "Internal Server Error",
              }),
            );
          }),
        deleteComputeVersion: (id: string) =>
          Effect.gen(function* () {
            calls.push(["deleteComputeVersion", id]);
            return yield* Effect.fail(
              new PrismaApiError({
                method: "DELETE",
                path: `/v1/versions/${id}`,
                status: 500,
                message: "Internal Server Error",
              }),
            );
          }),
      } as unknown as PrismaManagementClient;

      const http = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null))),
      );

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const error = yield* provider
          .reconcile({
            id: "App",
            instanceId: "00000000000000000000000000000000",
            news: {
              project: "project-1",
              serviceName: "api",
              artifact: "v2",
              port: 3000,
              destroyOldVersion: true,
            },
            olds: {
              project: "project-1",
              serviceName: "api",
              artifact: "v1",
              port: 3000,
            },
            output: {
              computeServiceId: "service-1",
              computeVersionId: "version-1",
              projectId: "project-1",
              serviceName: "api",
              regionId: "us-east-1",
              versionEndpointDomain: "version-1.preview.prisma.build",
              versionUrl: "https://version-1.preview.prisma.build",
              serviceEndpointDomain: "api.prisma.build",
              url: "https://api.prisma.build",
              promoted: true,
              previousVersionId: undefined,
              previousVersionAction: undefined,
              artifactHash: "old-hash",
              local: false,
            },
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          "Failed to delete Prisma compute version 'version-1'",
        );
        expect((error as Error).message).toContain(
          "Prisma API returned HTTP 500: Internal Server Error",
        );
        expect(calls).toContainEqual([
          "deleteComputeServiceVersion",
          "version-1",
        ]);
        expect(calls).toContainEqual(["deleteComputeVersion", "version-1"]);
      }).pipe(
        Effect.provide(ComputeProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("cleans up a newly created version when promotion fails", () => {
    const calls: Array<[string, unknown]> = [];
    const versions = new Map([["version-new", "new"]]);
    const client = {
      getComputeService: (id: string) => {
        calls.push(["getComputeService", id]);
        return Effect.succeed({
          id,
          type: "compute-service" as const,
          url: `https://api.prisma.test/v1/compute-services/${id}`,
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: "branch-main",
          latestVersionId: null,
          serviceEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      createServiceComputeVersion: (
        computeServiceId: string,
        input: unknown,
      ) => {
        calls.push([
          "createServiceComputeVersion",
          { computeServiceId, input },
        ]);
        return Effect.succeed({
          id: "version-new",
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-new",
          foundryVersionId: "foundry-new",
          uploadUrl: "https://upload.prisma.test/version-new.tar.gz",
        });
      },
      getComputeServiceVersion: (id: string) => {
        calls.push(["getComputeServiceVersion", id]);
        return Effect.succeed({
          id,
          type: "compute-version" as const,
          url: `https://api.prisma.test/v1/versions/${id}`,
          foundryVersionId: "foundry-new",
          status: versions.get(id) ?? "new",
          previewDomain: `${id}.preview.prisma.build`,
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      startComputeServiceVersion: (id: string) =>
        Effect.sync(() => {
          calls.push(["startComputeServiceVersion", id]);
          versions.set(id, "running");
          return { previewDomain: `${id}.preview.prisma.build` };
        }),
      promoteComputeService: (computeServiceId: string, versionId: string) =>
        Effect.gen(function* () {
          calls.push([
            "promoteComputeService",
            { computeServiceId, versionId },
          ]);
          return yield* Effect.fail(
            new PrismaApiError({
              method: "POST",
              path: `/v1/compute-services/${computeServiceId}/promote`,
              status: 500,
              message: "promote failed",
            }),
          );
        }),
      stopComputeServiceVersion: (id: string) =>
        Effect.sync(() => {
          calls.push(["stopComputeServiceVersion", id]);
          versions.set(id, "stopped");
        }),
      deleteComputeServiceVersion: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteComputeServiceVersion", id]);
          versions.delete(id);
        }),
    } as unknown as PrismaManagementClient;

    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null))),
    );

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            serviceName: "api",
            artifact: "v1",
            branchId: "branch-main",
          },
          olds: undefined,
          output: {
            computeServiceId: "service-1",
            computeVersionId: undefined,
            projectId: "project-1",
            serviceName: "api",
            regionId: "us-east-1",
            versionEndpointDomain: undefined,
            versionUrl: undefined,
            serviceEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: false,
            previousVersionId: undefined,
            previousVersionAction: undefined,
            artifactHash: undefined,
            local: false,
          },
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(PrismaApiError);
      expect((error as PrismaApiError).message).toBe("promote failed");
      expect(versions.has("version-new")).toBe(false);
      expect(calls).toEqual([
        ["getComputeService", "service-1"],
        [
          "createServiceComputeVersion",
          {
            computeServiceId: "service-1",
            input: {
              portMapping: { http: 8080 },
              skipCodeUpload: undefined,
            },
          },
        ],
        ["getComputeServiceVersion", "version-new"],
        ["startComputeServiceVersion", "version-new"],
        ["getComputeServiceVersion", "version-new"],
        [
          "promoteComputeService",
          { computeServiceId: "service-1", versionId: "version-new" },
        ],
        ["getComputeServiceVersion", "version-new"],
        ["stopComputeServiceVersion", "version-new"],
        ["getComputeServiceVersion", "version-new"],
        ["deleteComputeServiceVersion", "version-new"],
      ]);
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("deletes env vars removed from Compute props on update", () => {
    const calls: Array<[string, unknown]> = [];
    const byKey = new Map([
      [
        "TOKEN",
        {
          id: "env-token",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-token",
          projectId: "project-1",
          branchId: null,
          class: "production" as const,
          key: "TOKEN",
          valueKid: "kid-1",
          isManagedBySystem: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      [
        "KEEP",
        {
          id: "env-keep",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-keep",
          projectId: "project-1",
          branchId: null,
          class: "production" as const,
          key: "KEEP",
          valueKid: "kid-2",
          isManagedBySystem: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    ]);
    const client = {
      getComputeService: (id: string) => {
        calls.push(["getComputeService", id]);
        return Effect.succeed({
          id,
          type: "compute-service" as const,
          url: "https://api.prisma.test/v1/compute-services/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: "branch-main",
          latestVersionId: "version-old",
          serviceEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      listEnvironmentVariables: (query: { key: string }) => {
        calls.push(["listEnvironmentVariables", query]);
        const variable = byKey.get(query.key);
        return Effect.succeed(variable ? [variable] : []);
      },
      deleteEnvironmentVariable: (id: string) => {
        calls.push(["deleteEnvironmentVariable", id]);
        return Effect.void;
      },
      updateEnvironmentVariable: (id: string, input: unknown) => {
        calls.push(["updateEnvironmentVariable", { id, input }]);
        return Effect.succeed(byKey.get("KEEP"));
      },
      createEnvironmentVariable: (input: unknown) => {
        calls.push(["createEnvironmentVariable", input]);
        return Effect.succeed({
          id: "env-new",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-new",
          projectId: "project-1",
          branchId: null,
          class: "production" as const,
          key: "NEW",
          valueKid: "kid-3",
          isManagedBySystem: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        });
      },
      createServiceComputeVersion: (
        computeServiceId: string,
        input: unknown,
      ) => {
        calls.push([
          "createServiceComputeVersion",
          { computeServiceId, input },
        ]);
        return Effect.succeed({
          id: "version-new",
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-new",
          foundryVersionId: "foundry-new",
          uploadUrl: "https://upload.prisma.test/version-new.tar.gz",
        });
      },
      getComputeServiceVersion: (id: string) => {
        calls.push(["getComputeServiceVersion", id]);
        return Effect.succeed({
          id,
          type: "compute-version" as const,
          url: `https://api.prisma.test/v1/versions/${id}`,
          foundryVersionId: "foundry-new",
          status: "new",
          previewDomain: "version-new.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
    } as unknown as PrismaManagementClient;

    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null))),
    );

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          serviceName: "api",
          artifact: "v2",
          branchId: "branch-main",
          start: false,
          skipPromote: true,
          env: {
            KEEP: "new-value",
            NEW: "created",
          },
        },
        olds: {
          project: "project-1",
          serviceName: "api",
          artifact: "v1",
          branchId: "branch-main",
          start: false,
          skipPromote: true,
          env: {
            KEEP: "old-value",
            TOKEN: Redacted.make("secret"),
            ALREADY_ABSENT: null,
          },
        },
        output: {
          computeServiceId: "service-1",
          computeVersionId: "version-old",
          projectId: "project-1",
          serviceName: "api",
          regionId: "us-east-1",
          versionEndpointDomain: "version-old.preview.prisma.build",
          versionUrl: "https://version-old.preview.prisma.build",
          serviceEndpointDomain: "api.prisma.build",
          url: "https://api.prisma.build",
          promoted: true,
          previousVersionId: undefined,
          previousVersionAction: undefined,
          artifactHash: "old-hash",
          local: false,
        },
        session: undefined as never,
        bindings: [],
      });

      expect(output.computeVersionId).toBe("version-new");
      expect(calls).toEqual([
        ["getComputeService", "service-1"],
        [
          "listEnvironmentVariables",
          {
            projectId: "project-1",
            class: "production",
            key: "TOKEN",
            limit: 2,
          },
        ],
        ["deleteEnvironmentVariable", "env-token"],
        [
          "listEnvironmentVariables",
          {
            projectId: "project-1",
            class: "production",
            key: "KEEP",
            limit: 2,
          },
        ],
        [
          "updateEnvironmentVariable",
          { id: "env-keep", input: { value: "new-value" } },
        ],
        [
          "listEnvironmentVariables",
          {
            projectId: "project-1",
            class: "production",
            key: "NEW",
            limit: 2,
          },
        ],
        [
          "createEnvironmentVariable",
          {
            projectId: "project-1",
            class: "production",
            key: "NEW",
            value: "created",
          },
        ],
        [
          "createServiceComputeVersion",
          {
            computeServiceId: "service-1",
            input: {
              portMapping: { http: 8080 },
              skipCodeUpload: undefined,
            },
          },
        ],
        ["getComputeServiceVersion", "version-new"],
      ]);
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "returns an empty tail stream before a compute version exists",
    () =>
      Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const chunks = yield* Stream.runCollect(
          provider.tail!({
            id: "App",
            instanceId: "00000000000000000000000000000000",
            props: {
              project: "project-1",
              serviceName: "api",
            },
            output: {
              computeServiceId: "service-1",
              computeVersionId: undefined,
              projectId: "project-1",
              serviceName: "api",
              regionId: "us-east-1",
              versionEndpointDomain: undefined,
              versionUrl: undefined,
              serviceEndpointDomain: undefined,
              url: undefined,
              promoted: false,
              previousVersionId: undefined,
              previousVersionAction: undefined,
              artifactHash: undefined,
              local: false,
            },
          }),
        );

        expect(chunks).toEqual([]);
      }).pipe(
        Effect.provide(ComputeProvider()),
        Effect.provide(
          Layer.succeed(PrismaClient, {} as unknown as PrismaManagementClient),
        ),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      ),
  );

  it.effect("deletes Compute env vars on provider destroy", () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      listEnvironmentVariables: (query: unknown) => {
        calls.push(["listEnvironmentVariables", query]);
        return Effect.succeed([
          {
            id: "env-token",
            type: "environment-variable" as const,
            url: "https://api.prisma.test/v1/environment-variables/env-token",
            projectId: "project-1",
            branchId: null,
            class: "production" as const,
            key: "TOKEN",
            valueKid: "kid-1",
            isManagedBySystem: false,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ]);
      },
      deleteEnvironmentVariable: (id: string) => {
        calls.push(["deleteEnvironmentVariable", id]);
        return Effect.void;
      },
      listServiceComputeVersions: (
        computeServiceId: string,
        query: unknown,
      ) => {
        calls.push(["listServiceComputeVersions", { computeServiceId, query }]);
        return Effect.succeed([]);
      },
      deleteComputeService: (id: string) => {
        calls.push(["deleteComputeService", id]);
        return Effect.void;
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      yield* provider.delete({
        id: "App",
        instanceId: "00000000000000000000000000000000",
        olds: {
          project: "project-1",
          serviceName: "api",
          env: {
            TOKEN: Redacted.make("secret"),
            ALREADY_ABSENT: null,
            SKIP_ME: undefined,
          },
        },
        output: {
          computeServiceId: "service-1",
          computeVersionId: "version-1",
          projectId: "project-1",
          serviceName: "api",
          regionId: "us-east-1",
          versionEndpointDomain: "version-1.preview.prisma.build",
          versionUrl: "https://version-1.preview.prisma.build",
          serviceEndpointDomain: "api.prisma.build",
          url: "https://api.prisma.build",
          promoted: true,
          previousVersionId: undefined,
          previousVersionAction: undefined,
          artifactHash: "hash-1",
          local: false,
        },
        session: undefined as never,
        bindings: [],
      });

      expect(calls).toEqual([
        [
          "listEnvironmentVariables",
          {
            projectId: "project-1",
            class: "production",
            key: "TOKEN",
            limit: 2,
          },
        ],
        ["deleteEnvironmentVariable", "env-token"],
        [
          "listServiceComputeVersions",
          { computeServiceId: "service-1", query: { limit: 100 } },
        ],
        ["deleteComputeService", "service-1"],
      ]);
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("skips system-managed Compute env vars on provider destroy", () => {
    const calls: Array<[string, unknown]> = [];
    const byKey = new Map([
      [
        "TOKEN",
        {
          id: "env-token",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-token",
          projectId: "project-1",
          branchId: null,
          class: "production" as const,
          key: "TOKEN",
          valueKid: "kid-token",
          isManagedBySystem: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      [
        "PRISMA_INTERNAL_URL",
        {
          id: "env-system",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-system",
          projectId: "project-1",
          branchId: null,
          class: "production" as const,
          key: "PRISMA_INTERNAL_URL",
          valueKid: "kid-system",
          isManagedBySystem: true,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    ]);
    const client = {
      listEnvironmentVariables: (query: { key: string }) => {
        calls.push(["listEnvironmentVariables", query]);
        return Effect.succeed(
          byKey.get(query.key) ? [byKey.get(query.key)] : [],
        );
      },
      deleteEnvironmentVariable: (id: string) => {
        calls.push(["deleteEnvironmentVariable", id]);
        return Effect.void;
      },
      listServiceComputeVersions: (
        computeServiceId: string,
        query: unknown,
      ) => {
        calls.push(["listServiceComputeVersions", { computeServiceId, query }]);
        return Effect.succeed([]);
      },
      deleteComputeService: (id: string) => {
        calls.push(["deleteComputeService", id]);
        return Effect.void;
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      yield* provider.delete({
        id: "App",
        instanceId: "00000000000000000000000000000000",
        olds: {
          project: "project-1",
          serviceName: "api",
          env: {
            TOKEN: Redacted.make("secret"),
            PRISMA_INTERNAL_URL: Redacted.make("prisma-owned"),
          },
        },
        output: {
          computeServiceId: "service-1",
          computeVersionId: "version-1",
          projectId: "project-1",
          serviceName: "api",
          regionId: "us-east-1",
          versionEndpointDomain: "version-1.preview.prisma.build",
          versionUrl: "https://version-1.preview.prisma.build",
          serviceEndpointDomain: "api.prisma.build",
          url: "https://api.prisma.build",
          promoted: true,
          previousVersionId: undefined,
          previousVersionAction: undefined,
          artifactHash: "hash-1",
          local: false,
        },
        session: undefined as never,
        bindings: [],
      });

      expect(calls).toEqual([
        [
          "listEnvironmentVariables",
          {
            projectId: "project-1",
            class: "production",
            key: "TOKEN",
            limit: 2,
          },
        ],
        ["deleteEnvironmentVariable", "env-token"],
        [
          "listEnvironmentVariables",
          {
            projectId: "project-1",
            class: "production",
            key: "PRISMA_INTERNAL_URL",
            limit: 2,
          },
        ],
        [
          "listServiceComputeVersions",
          { computeServiceId: "service-1", query: { limit: 100 } },
        ],
        ["deleteComputeService", "service-1"],
      ]);
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("deletes Compute env vars when old props are missing", () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      listEnvironmentVariables: (query: { key: string }) => {
        calls.push(["listEnvironmentVariables", query]);
        return Effect.succeed(
          query.key === "TOKEN"
            ? [
                {
                  id: "env-token",
                  type: "environment-variable" as const,
                  url: "https://api.prisma.test/v1/environment-variables/env-token",
                  projectId: "project-1",
                  branchId: null,
                  class: "production" as const,
                  key: "TOKEN",
                  valueKid: "kid-1",
                  isManagedBySystem: false,
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-01T00:00:00Z",
                },
              ]
            : [],
        );
      },
      deleteEnvironmentVariable: (id: string) => {
        calls.push(["deleteEnvironmentVariable", id]);
        return Effect.void;
      },
      listServiceComputeVersions: (
        computeServiceId: string,
        query: unknown,
      ) => {
        calls.push(["listServiceComputeVersions", { computeServiceId, query }]);
        return Effect.succeed([]);
      },
      deleteComputeService: (id: string) => {
        calls.push(["deleteComputeService", id]);
        return Effect.void;
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      yield* provider.delete({
        id: "App",
        instanceId: "00000000000000000000000000000000",
        olds: undefined as never,
        output: {
          computeServiceId: "service-1",
          computeVersionId: "version-1",
          projectId: "project-1",
          serviceName: "api",
          regionId: "us-east-1",
          versionEndpointDomain: "version-1.preview.prisma.build",
          versionUrl: "https://version-1.preview.prisma.build",
          serviceEndpointDomain: "api.prisma.build",
          url: "https://api.prisma.build",
          promoted: true,
          previousVersionId: undefined,
          previousVersionAction: undefined,
          environmentKeys: ["TOKEN"],
          environmentClass: "preview",
          artifactHash: "hash-1",
          local: false,
        },
        session: undefined as never,
        bindings: [],
      });

      expect(calls).toEqual([
        [
          "listEnvironmentVariables",
          {
            projectId: "project-1",
            class: "preview",
            key: "TOKEN",
            limit: 2,
          },
        ],
        ["deleteEnvironmentVariable", "env-token"],
        [
          "listServiceComputeVersions",
          { computeServiceId: "service-1", query: { limit: 100 } },
        ],
        ["deleteComputeService", "service-1"],
      ]);
    }).pipe(
      Effect.provide(ComputeProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "continues Compute destroy when managed env vars are already gone",
    () => {
      const calls: Array<[string, unknown]> = [];
      const client = {
        listEnvironmentVariables: (query: unknown) =>
          Effect.gen(function* () {
            calls.push(["listEnvironmentVariables", query]);
            return yield* Effect.fail(
              new PrismaApiError({
                method: "GET",
                path: "/v1/environment-variables",
                status: 404,
                message: "project not found",
              }),
            );
          }),
        listServiceComputeVersions: (
          computeServiceId: string,
          query: unknown,
        ) => {
          calls.push([
            "listServiceComputeVersions",
            { computeServiceId, query },
          ]);
          return Effect.succeed([]);
        },
        deleteComputeService: (id: string) => {
          calls.push(["deleteComputeService", id]);
          return Effect.void;
        },
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        yield* provider.delete({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          olds: {
            project: "project-1",
            serviceName: "api",
            env: {
              TOKEN: Redacted.make("secret"),
            },
          },
          output: {
            computeServiceId: "service-1",
            computeVersionId: "version-1",
            projectId: "project-1",
            serviceName: "api",
            regionId: "us-east-1",
            versionEndpointDomain: "version-1.preview.prisma.build",
            versionUrl: "https://version-1.preview.prisma.build",
            serviceEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: true,
            previousVersionId: undefined,
            previousVersionAction: undefined,
            artifactHash: "hash-1",
            local: false,
          },
          session: undefined as never,
          bindings: [],
        });

        expect(calls).toEqual([
          [
            "listEnvironmentVariables",
            {
              projectId: "project-1",
              class: "production",
              key: "TOKEN",
              limit: 2,
            },
          ],
          [
            "listServiceComputeVersions",
            { computeServiceId: "service-1", query: { limit: 100 } },
          ],
          ["deleteComputeService", "service-1"],
        ]);
      }).pipe(
        Effect.provide(ComputeProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("tails Compute logs through the provider", () =>
    withWebSocketServer((server) =>
      Effect.gen(function* () {
        const url = yield* listenUrl(server);
        const calls: Array<[string, unknown]> = [];
        let authorization: string | undefined;

        server.on("connection", (socket, request) => {
          authorization = request.headers.authorization;
          socket.send(
            JSON.stringify({
              type: "log",
              text: "compute app log",
              byteStart: 0,
              byteEnd: 15,
            }),
          );
          socket.send(
            JSON.stringify({
              type: "terminal",
              kind: "end",
              code: "vm_stopped",
              message: "done",
              retryable: false,
              cursor: null,
            }),
          );
        });

        const client = {
          getComputeVersionLogsRequest: (versionId: string, query: unknown) =>
            Effect.sync(() => {
              calls.push([
                "getComputeVersionLogsRequest",
                { versionId, query },
              ]);
              return {
                url: `${url}/v1/compute-services/versions/${versionId}/logs`,
                headers: {
                  Authorization: Redacted.make("Bearer app-token"),
                },
              };
            }),
        } as unknown as PrismaManagementClient;

        const provider = yield* Compute.Provider.pipe(
          Effect.provide(ComputeProvider()),
          Effect.provide(Layer.succeed(PrismaClient, client)),
        );
        const lines = yield* provider.tail!({
          id: "App",
          instanceId: "00000000000000000000000000000000",
          props: {
            project: "project-1",
            serviceName: "api",
          },
          output: {
            computeServiceId: "service-1",
            computeVersionId: "version-1",
            projectId: "project-1",
            serviceName: "api",
            regionId: "us-east-1",
            versionEndpointDomain: "version-1.preview.prisma.build",
            versionUrl: "https://version-1.preview.prisma.build",
            serviceEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: true,
            previousVersionId: undefined,
            previousVersionAction: undefined,
            artifactHash: "hash-1",
            local: false,
          },
        }).pipe(Stream.runCollect);

        expect(lines.map((line) => line.message)).toEqual(["compute app log"]);
        expect(authorization).toBe("Bearer app-token");
        expect(calls).toEqual([
          [
            "getComputeVersionLogsRequest",
            { versionId: "version-1", query: undefined },
          ],
        ]);
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      ),
    ),
  );
});

const withWebSocketServer = <A, E, R>(
  f: (server: WebSocketServer) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new WebSocketServer({ host: "127.0.0.1", port: 0 })),
    f,
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }).pipe(Effect.ignore),
  );

const listenUrl = (server: WebSocketServer) =>
  Effect.callback<string, Error>((resume) => {
    const complete = () => {
      cleanup();
      const address = server.address();
      if (address && typeof address === "object") {
        resume(Effect.succeed(`ws://127.0.0.1:${address.port}`));
      } else {
        resume(Effect.fail(new Error("WebSocket server has no TCP address")));
      }
    };
    const fail = (cause: unknown) => {
      cleanup();
      resume(
        Effect.fail(cause instanceof Error ? cause : new Error(String(cause))),
      );
    };
    const cleanup = () => {
      server.off("listening", complete);
      server.off("error", fail);
    };

    if (server.address()) {
      complete();
      return;
    }

    server.once("listening", complete);
    server.once("error", fail);
    return Effect.sync(cleanup);
  });
