import {
  ComputeVersion as PrismaComputeVersion,
  ComputeVersionProvider,
} from "@/Prisma/ComputeVersion";
import * as Output from "@/Output";
import {
  PrismaApiError,
  PrismaClient,
  type PrismaManagementClient,
} from "@/Prisma/Client";
import { PlatformServices } from "@/Util/PlatformServices";
import { sha256, sha256Object } from "@/Util/sha256";
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
import { WebSocketServer } from "ws";

describe("Prisma ComputeVersion", () => {
  it.effect(
    "fails when Prisma omits an upload URL for version artifacts",
    () => {
      const calls: Array<[string, unknown?]> = [];
      const client = {
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
        const provider = yield* PrismaComputeVersion.Provider;
        const error = yield* provider
          .reconcile({
            id: "Version",
            instanceId: "00000000000000000000000000000000",
            news: {
              computeService: "service-1",
              artifact: "archive-bytes",
            },
            olds: undefined,
            output: undefined,
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
        Effect.provide(ComputeVersionProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("deletes created Compute version when version upload fails", () => {
    const calls: Array<[string, unknown?]> = [];
    const client = {
      createServiceComputeVersion: () => {
        calls.push(["createServiceComputeVersion"]);
        return Effect.succeed({
          id: "version-1",
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: "https://upload.prisma.test/version.tar.gz",
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
      const provider = yield* PrismaComputeVersion.Provider;
      const error = yield* provider
        .reconcile({
          id: "Version",
          instanceId: "00000000000000000000000000000000",
          news: {
            computeService: "service-1",
            artifact: "archive-bytes",
          },
          olds: undefined,
          output: undefined,
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
      Effect.provide(ComputeVersionProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("uploads version artifact bytes from artifactPath", () => {
    let uploaded:
      | { url: string; contentType: string | undefined; bytes: Uint8Array }
      | undefined;
    const client = {
      createServiceComputeVersion: (
        _computeServiceId: string,
        input: unknown,
      ) =>
        Effect.succeed({
          id: "version-1",
          type: "compute-version" as const,
          url: "https://api.prisma.test/v1/versions/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: "https://upload.prisma.test/version.tar.gz",
          input,
        }),
      getComputeVersion: (id: string) =>
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
        prefix: "alchemy-prisma-version-artifact-",
      });
      const artifactPath = path.join(root, "version.tar.gz");
      yield* fs.writeFileString(artifactPath, "version-archive");

      const provider = yield* PrismaComputeVersion.Provider;
      const output = yield* provider.reconcile({
        id: "Version",
        instanceId: "00000000000000000000000000000000",
        news: {
          computeService: "service-1",
          artifactPath,
        },
        olds: undefined,
        output: undefined,
        session: undefined as never,
        bindings: [],
      });

      expect(output.computeVersionId).toBe("version-1");
      expect(output.artifactHash).toBeDefined();
      expect(uploaded?.url).toBe("https://upload.prisma.test/version.tar.gz");
      expect(uploaded?.contentType).toBe("application/octet-stream");
      expect(new TextDecoder().decode(uploaded?.bytes)).toBe("version-archive");
    }).pipe(
      Effect.provide(ComputeVersionProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "falls back to the global version route when read sees a service-scoped miss",
    () => {
      const calls: Array<[string, unknown?]> = [];
      const client = {
        listServiceComputeVersions: () =>
          Effect.die("saved compute version read should not list versions"),
        getComputeServiceVersion: (id: string) =>
          Effect.gen(function* () {
            calls.push(["getComputeServiceVersion", id]);
            return yield* Effect.fail(
              new PrismaApiError({
                method: "GET",
                path: `/v1/compute-services/versions/${id}`,
                status: 404,
                message: "not found",
              }),
            );
          }),
        getComputeVersion: (id: string) =>
          Effect.sync(() => {
            calls.push(["getComputeVersion", id]);
            return {
              id,
              type: "compute-version" as const,
              url: `https://api.prisma.test/v1/versions/${id}`,
              foundryVersionId: "foundry-1",
              status: "stopped",
              previewDomain: "version-1.preview.prisma.build",
              createdAt: "2026-01-01T00:00:00Z",
            };
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* PrismaComputeVersion.Provider;
        const output = yield* provider.read!({
          id: "Version",
          instanceId: "00000000000000000000000000000000",
          olds: {
            computeService: "service-1",
          },
          output: {
            computeVersionId: "version-1",
            computeServiceId: "service-1",
            foundryVersionId: "foundry-1",
            status: "running",
            previewDomain: undefined,
            uploadUrl: undefined,
            artifactHash: undefined,
            serviceEndpointDomain: undefined,
            createdAt: "2026-01-01T00:00:00Z",
          },
        });

        expect(output?.computeVersionId).toBe("version-1");
        expect(output?.status).toBe("stopped");
        expect(calls).toEqual([
          ["getComputeServiceVersion", "version-1"],
          ["getComputeVersion", "version-1"],
        ]);
      }).pipe(
        Effect.provide(ComputeVersionProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect(
    "uses the output compute service ID when reading a saved version",
    () => {
      const calls: Array<[string, unknown?]> = [];
      const client = {
        listServiceComputeVersions: () =>
          Effect.die("saved compute version read should not list versions"),
        getComputeServiceVersion: (id: string) =>
          Effect.sync(() => {
            calls.push(["getComputeServiceVersion", id]);
            return {
              id,
              type: "compute-version" as const,
              url: `https://api.prisma.test/v1/versions/${id}`,
              foundryVersionId: "foundry-1",
              status: "running",
              previewDomain: "version-1.preview.prisma.build",
              createdAt: "2026-01-01T00:00:00Z",
            };
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* PrismaComputeVersion.Provider;
        const output = yield* provider.read!({
          id: "Version",
          instanceId: "00000000000000000000000000000000",
          olds: {
            computeService: "service-from-olds",
          },
          output: {
            computeVersionId: "version-1",
            computeServiceId: "service-from-output",
            foundryVersionId: "foundry-1",
            status: "stopped",
            previewDomain: undefined,
            uploadUrl: undefined,
            artifactHash: undefined,
            serviceEndpointDomain: undefined,
            createdAt: "2026-01-01T00:00:00Z",
          },
        });

        expect(output?.computeServiceId).toBe("service-from-output");
        expect(output?.status).toBe("running");
        expect(calls).toEqual([["getComputeServiceVersion", "version-1"]]);
      }).pipe(
        Effect.provide(ComputeVersionProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect(
    "falls back to the foundry version ID when the saved version is gone",
    () => {
      const calls: Array<[string, unknown?]> = [];
      const notFound = (path: string) =>
        new PrismaApiError({
          method: "GET",
          path,
          status: 404,
          message: "not found",
        });
      const client = {
        listServiceComputeVersions: (
          computeServiceId: string,
          query: unknown,
        ) =>
          Effect.sync(() => {
            calls.push([
              "listServiceComputeVersions",
              { computeServiceId, query },
            ]);
            return [
              {
                id: "version-new",
                type: "compute-version" as const,
                url: "https://api.prisma.test/v1/versions/version-new",
                foundryVersionId: "foundry-1",
                createdAt: "2026-01-01T00:00:00Z",
              },
            ];
          }),
        getComputeServiceVersion: (id: string) =>
          Effect.gen(function* () {
            calls.push(["getComputeServiceVersion", id]);
            if (id === "version-old") {
              return yield* Effect.fail(
                notFound(`/v1/compute-services/versions/${id}`),
              );
            }
            return {
              id,
              type: "compute-version" as const,
              url: `https://api.prisma.test/v1/versions/${id}`,
              foundryVersionId: "foundry-1",
              status: "running",
              previewDomain: "version-new.preview.prisma.build",
              createdAt: "2026-01-01T00:00:00Z",
            };
          }),
        getComputeVersion: (id: string) =>
          Effect.gen(function* () {
            calls.push(["getComputeVersion", id]);
            return yield* Effect.fail(notFound(`/v1/versions/${id}`));
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* PrismaComputeVersion.Provider;
        const output = yield* provider.read!({
          id: "Version",
          instanceId: "00000000000000000000000000000000",
          olds: {
            computeService: "service-from-olds",
          },
          output: {
            computeVersionId: "version-old",
            computeServiceId: "service-from-output",
            foundryVersionId: "foundry-1",
            status: "stopped",
            previewDomain: undefined,
            uploadUrl: undefined,
            artifactHash: undefined,
            serviceEndpointDomain: undefined,
            createdAt: "2026-01-01T00:00:00Z",
          },
        });

        expect(output?.computeVersionId).toBe("version-new");
        expect(output?.computeServiceId).toBe("service-from-output");
        expect(calls).toEqual([
          ["getComputeServiceVersion", "version-old"],
          ["getComputeVersion", "version-old"],
          [
            "listServiceComputeVersions",
            { computeServiceId: "service-from-output", query: { limit: 100 } },
          ],
          ["getComputeServiceVersion", "version-new"],
        ]);
      }).pipe(
        Effect.provide(ComputeVersionProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("replaces when artifactPath contents change", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-version-diff-",
      });
      const artifactPath = path.join(root, "version.tar.gz");
      yield* fs.writeFileString(artifactPath, "new-version");

      const provider = yield* PrismaComputeVersion.Provider;
      const diff = yield* provider.diff!({
        id: "Version",
        instanceId: "00000000000000000000000000000000",
        olds: {
          computeService: "service-1",
          artifactPath,
        },
        news: {
          computeService: "service-1",
          artifactPath,
        },
        oldBindings: [],
        newBindings: [],
        output: {
          computeVersionId: "version-1",
          computeServiceId: "service-1",
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: null,
          uploadUrl: "https://upload.prisma.test/version.tar.gz",
          artifactHash: "old-hash",
          serviceEndpointDomain: undefined,
          createdAt: "2026-01-01T00:00:00Z",
        },
      } as never);

      expect(diff).toEqual({ action: "replace" });
    }).pipe(
      Effect.provide(ComputeVersionProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "replaces changed artifacts even when computeService is unresolved",
    () => {
      const client = {} as PrismaManagementClient;

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-prisma-version-unresolved-diff-",
        });
        const artifactPath = path.join(root, "version.tar.gz");
        yield* fs.writeFileString(artifactPath, "new-version");

        const provider = yield* PrismaComputeVersion.Provider;
        const diff = yield* provider.diff!({
          id: "Version",
          instanceId: "00000000000000000000000000000000",
          olds: {
            computeService: "service-1",
            artifactPath,
          },
          news: {
            computeService: Output.asOutput("service-1"),
            artifactPath,
          },
          oldBindings: [],
          newBindings: [],
          output: {
            computeVersionId: "version-1",
            computeServiceId: "service-1",
            foundryVersionId: "foundry-1",
            status: "new",
            previewDomain: null,
            uploadUrl: "https://upload.prisma.test/version.tar.gz",
            artifactHash: "old-hash",
            serviceEndpointDomain: undefined,
            createdAt: "2026-01-01T00:00:00Z",
          },
        } as never);

        expect(diff).toEqual({ action: "replace" });
      }).pipe(
        Effect.provide(ComputeVersionProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("does not replace when artifact bytes are unchanged", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const artifact = new TextEncoder().encode("same-version");
      const artifactHash = yield* sha256Object({
        artifact: yield* sha256(artifact),
        contentType: "application/octet-stream",
      });

      const provider = yield* PrismaComputeVersion.Provider;
      const diff = yield* provider.diff!({
        id: "Version",
        instanceId: "00000000000000000000000000000000",
        olds: {
          computeService: "service-1",
          artifact: new Uint8Array(artifact),
        },
        news: {
          computeService: "service-1",
          artifact: new Uint8Array(artifact),
        },
        oldBindings: [],
        newBindings: [],
        output: {
          computeVersionId: "version-1",
          computeServiceId: "service-1",
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: null,
          uploadUrl: "https://upload.prisma.test/version.tar.gz",
          artifactHash,
          serviceEndpointDomain: undefined,
          createdAt: "2026-01-01T00:00:00Z",
        },
      } as never);

      expect(diff).toBeUndefined();
    }).pipe(
      Effect.provide(ComputeVersionProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("does not re-promote an already promoted Compute version", () => {
    const calls: Array<[string, unknown?]> = [];
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
          status: "new",
          previewDomain: "version-1.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      getComputeService: (id: string) => {
        calls.push(["getComputeService", id]);
        return Effect.succeed(service());
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
      computeService: "service-1",
      skipCodeUpload: true,
      promote: true,
    };

    return Effect.gen(function* () {
      const provider = yield* PrismaComputeVersion.Provider;
      const first = yield* provider.reconcile({
        id: "Version",
        instanceId: "00000000000000000000000000000000",
        news,
        olds: undefined,
        output: undefined,
        session: undefined as never,
        bindings: [],
      });

      const second = yield* provider.reconcile({
        id: "Version",
        instanceId: "00000000000000000000000000000000",
        news,
        olds: news,
        output: first,
        session: undefined as never,
        bindings: [],
      });

      expect(first.computeVersionId).toBe("version-1");
      expect(second.computeVersionId).toBe("version-1");
      expect(second.serviceEndpointDomain).toBe("api.prisma.build");
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
      Effect.provide(ComputeVersionProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "falls back to the global start route for direct Compute versions",
    () => {
      const calls: Array<[string, unknown?]> = [];
      let status = "new";
      const client = {
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
            status,
            previewDomain: "version-1.preview.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        startComputeServiceVersion: (id: string) =>
          Effect.gen(function* () {
            calls.push(["startComputeServiceVersion", id]);
            return yield* Effect.fail(
              new PrismaApiError({
                method: "POST",
                path: `/v1/compute-services/versions/${id}/start`,
                status: 404,
                message: "not found",
              }),
            );
          }),
        startComputeVersion: (id: string) =>
          Effect.sync(() => {
            calls.push(["startComputeVersion", id]);
            status = "running";
            return { previewDomain: "version-1.preview.prisma.build" };
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* PrismaComputeVersion.Provider;
        const output = yield* provider.reconcile({
          id: "Version",
          instanceId: "00000000000000000000000000000000",
          news: {
            computeService: "service-1",
            skipCodeUpload: true,
            start: true,
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        });

        expect(output.status).toBe("running");
        expect(calls).toEqual([
          [
            "createServiceComputeVersion",
            {
              computeServiceId: "service-1",
              input: { portMapping: undefined, skipCodeUpload: true },
            },
          ],
          ["getComputeServiceVersion", "version-1"],
          ["startComputeServiceVersion", "version-1"],
          ["startComputeVersion", "version-1"],
          ["getComputeServiceVersion", "version-1"],
        ]);
      }).pipe(
        Effect.provide(ComputeVersionProvider()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("tails ComputeVersion logs through the provider", () =>
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
              text: "direct version log",
              byteStart: 0,
              byteEnd: 18,
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
                  Authorization: Redacted.make("Bearer version-token"),
                },
              };
            }),
        } as unknown as PrismaManagementClient;

        const provider = yield* PrismaComputeVersion.Provider.pipe(
          Effect.provide(ComputeVersionProvider()),
          Effect.provide(Layer.succeed(PrismaClient, client)),
          Effect.provide(PlatformServices),
        );
        const lines = yield* provider.tail!({
          id: "ComputeVersion",
          instanceId: "00000000000000000000000000000000",
          props: {
            computeService: "service-1",
          },
          output: {
            computeVersionId: "version-1",
            computeServiceId: "service-1",
            foundryVersionId: "foundry-1",
            status: "running",
            previewDomain: "version-1.preview.prisma.build",
            uploadUrl: undefined,
            serviceEndpointDomain: undefined,
            createdAt: "2026-01-01T00:00:00Z",
          },
        }).pipe(Stream.runCollect);

        expect(lines.map((line) => line.message)).toEqual([
          "direct version log",
        ]);
        expect(authorization).toBe("Bearer version-token");
        expect(calls).toEqual([
          [
            "getComputeVersionLogsRequest",
            { versionId: "version-1", query: undefined },
          ],
        ]);
      }).pipe(Effect.provide(FetchHttpClient.layer)),
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
