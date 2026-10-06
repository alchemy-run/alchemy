import { gunzipSync } from "node:zlib";
import { BadRequest, fromApiToken } from "@distilled.cloud/prisma";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { WebSocketServer } from "ws";
import { AlchemyContext } from "@/AlchemyContext";
import * as Drift from "@/Drift.ts";
import * as Prisma from "@/Prisma";
import { PrismaClient, type PrismaManagementClient } from "@/Prisma/Client";
import {
  Compute,
  ComputeProvider,
  syncComputeEnvironment,
  waitForDeploymentUrl,
  type ComputeProps,
} from "@/Prisma/Compute";
import { Credentials } from "@/Prisma/Credentials";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { PlatformServices } from "@/Util/PlatformServices";
import {
  type FakeComputeCloud,
  fakeComputeProviders,
  isRoute,
  MAIN_BRANCH_ID,
  makeFakeComputeCloud,
  PROJECT_ID,
  rejected,
} from "./fixtures/ComputeFakeCloud.ts";
import {
  type Captured,
  conflict,
  dispatchTo,
  FAKE_API_BASE_URL,
  makeFakeManagementApi,
  notFound,
  unhandled,
} from "./fixtures/FakeManagementApi.ts";
import { failureOf, patchStateAttr } from "./fixtures/Live.ts";
import { testStackContext } from "./fixtures/StackContext.ts";

const fixtureArtifactPath = `${import.meta.dirname}/fixtures/artifact-archive.bin`;
const fixtureArtifactV1Path = `${import.meta.dirname}/fixtures/artifact-v1.bin`;
const fixtureArtifactV2Path = `${import.meta.dirname}/fixtures/artifact-v2.bin`;

const readTarString = (buffer: Uint8Array, start: number, length: number) => {
  const bytes = buffer.slice(start, start + length);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? bytes.slice(0, end) : bytes);
};

const readTarFile = (buffer: Uint8Array, expectedName: string) => {
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.slice(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8);
    const bodyStart = offset + 512;
    if (fullName === expectedName) {
      return new TextDecoder().decode(buffer.slice(bodyStart, bodyStart + size));
    }
    offset = bodyStart + size + ((512 - (size % 512)) % 512);
  }
  throw new Error(`Missing tar entry '${expectedName}'.`);
};

const liveProviderContext = Layer.succeed(AlchemyContext, {
  dotAlchemy: ".alchemy-test",
  dev: false,
  adopt: false,
});

const computeProviderLive = () =>
  ComputeProvider().pipe(
    Layer.provide(Layer.mergeAll(liveProviderContext, testStackContext, PlatformServices)),
  );

/**
 * Serve the Management API from client-shaped handlers for the helper tests
 * below (`syncComputeEnvironment`, log tailing), which run without a stack.
 * `dispatchTo` maps each handler's result onto the wire (see the fixture).
 */
const dispatchManagement = (client: any, request: Captured): Response => {
  const [head, id, tail] = request.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .slice(1);
  const body = request.bodyJson as any;
  const query = Object.fromEntries(new URLSearchParams(request.search));
  const { call, callVoid, list } = dispatchTo(request);

  if (head === "services") {
    if (id === undefined) {
      return request.method === "GET"
        ? call(client.listApps, [query], list)
        : call(client.createApp, [body]);
    }
    if (tail === "deployments") {
      return request.method === "GET"
        ? call(client.listAppDeployments, [id, query], list)
        : call(client.createAppDeployment, [id, body]);
    }
    if (tail === "promote") return call(client.promoteApp, [id, body]);
    if (tail === "rollback") return call(client.rollbackApp, [id, body]);
    if (tail === undefined) {
      if (request.method === "GET") return call(client.getApp, [id]);
      if (request.method === "PATCH") return call(client.updateApp, [id, body]);
      if (request.method === "DELETE") {
        return callVoid(client.deleteApp, [id]);
      }
    }
  }
  if (head === "branches" && id !== undefined && request.method === "GET") {
    return call(client.getBranch, [id]);
  }
  if (head === "projects" && id !== undefined) {
    if (tail === "branches" && request.method === "GET") {
      return call(client.listBranches, [id, query], list);
    }
    if (tail === undefined && request.method === "DELETE") {
      return callVoid(client.deleteProject, [id]);
    }
  }
  if (head === "deployments" && id !== undefined) {
    if (tail === "start") return call(client.startDeployment, [id]);
    if (tail === "stop") {
      return callVoid(client.stopDeployment, [id]);
    }
    if (request.method === "GET") return call(client.getDeployment, [id]);
    if (request.method === "DELETE") {
      return callVoid(client.deleteDeployment, [id]);
    }
  }
  if (head === "environment-variables") {
    if (id === undefined) {
      return request.method === "GET"
        ? call(client.listEnvironmentVariables, [query], list)
        : call(client.createEnvironmentVariable, [body]);
    }
    if (request.method === "GET") {
      return call(client.getEnvironmentVariable, [id]);
    }
    if (request.method === "PATCH") {
      return call(client.updateEnvironmentVariable, [id, body]);
    }
    if (request.method === "DELETE") {
      return callVoid(client.deleteEnvironmentVariable, [id]);
    }
  }
  return unhandled(request);
};

/**
 * Ambient HTTP for a helper test: Management API requests dispatch to the
 * client-shaped handlers; anything else falls back to the HttpClient
 * provided beneath this layer, when there is one.
 */
const apiRoutedHttp = (client: any) =>
  Layer.mergeAll(
    Layer.effect(
      HttpClient.HttpClient,
      Effect.gen(function* () {
        const fallback = yield* Effect.serviceOption(HttpClient.HttpClient);
        return HttpClient.make((request) => {
          if (!request.url.startsWith(FAKE_API_BASE_URL)) {
            return Option.isSome(fallback)
              ? fallback.value.execute(request)
              : Effect.sync(() =>
                  HttpClientResponse.fromWeb(
                    request,
                    unhandled({
                      url: request.url,
                      method: request.method,
                      pathname: new URL(request.url).pathname,
                      search: "",
                      authorization: undefined,
                      bodyJson: undefined,
                    }),
                  ),
                );
          }
          return Effect.sync(() => {
            const url = new URL(request.url);
            const body = request.body as HttpBody.HttpBody;
            const bodyText = body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "";
            return HttpClientResponse.fromWeb(
              request,
              dispatchManagement(client, {
                url: request.url,
                method: request.method,
                pathname: url.pathname,
                search: url.search,
                authorization: request.headers.authorization,
                bodyJson: bodyText ? JSON.parse(bodyText) : undefined,
              }),
            );
          });
        });
      }),
    ),
    fromApiToken({ apiToken: Redacted.make("fake-service-token"), apiBaseUrl: FAKE_API_BASE_URL }),
  );

describe(
  "Prisma Compute helpers",
  { tags: ["unit", "provider:prisma", "provider:prisma:compute", "local"] },
  () => {
    it.live("accepts a streaming 200 response without consuming its body", () => {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          // Deliberately never enqueue or close. Reading this body would hang.
        },
      });
      const http = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }))),
      );

      return waitForDeploymentUrl("https://app.prisma.build", {
        project: "project-1",
        appName: "api",
        urlReadinessTimeoutSeconds: 0.05,
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, http)));
    });

    it.live("waits for the configured application health contract", () => {
      const requests: string[] = [];
      const http = HttpClient.make((request) => {
        requests.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: requests.length === 1 ? 503 : 204 }),
          ),
        );
      });

      return Effect.gen(function* () {
        yield* waitForDeploymentUrl("https://app.prisma.build", {
          project: "project-1",
          appName: "api",
          healthCheck: { path: "/api/health" },
          pollIntervalMs: 1,
          // Wall-clock deadline (live clock). The mock succeeds on the second
          // poll, so the pass path never waits this long — it only needs to
          // not fire spuriously when a saturated event loop (full-suite run)
          // delays the second poll beyond a tight budget.
          urlReadinessTimeoutSeconds: 30,
        });

        expect(requests).toEqual([
          "https://app.prisma.build/api/health",
          "https://app.prisma.build/api/health",
        ]);
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, http)));
    });

    it.effect("rejects unsafe application health contracts", () =>
      Effect.gen(function* () {
        const pathError = yield* waitForDeploymentUrl("https://app.prisma.build", {
          project: "project-1",
          appName: "api",
          healthCheck: { path: "//attacker.example/health" },
        }).pipe(Effect.flip);
        const statusError = yield* waitForDeploymentUrl("https://app.prisma.build", {
          project: "project-1",
          appName: "api",
          healthCheck: { path: "/health", statusCodes: [] },
        }).pipe(Effect.flip);

        expect(pathError.message).toContain("healthCheck.path");
        expect(statusError.message).toContain("healthCheck.statusCodes");
      }),
    );

    it.effect("fails closed when an application health probe cannot run", () =>
      Effect.gen(function* () {
        const props = {
          project: "project-1",
          appName: "api",
          healthCheck: { path: "/health" },
        } as const;
        const missingUrl = yield* waitForDeploymentUrl(undefined, props).pipe(Effect.flip);
        const missingRoutingUrl = yield* waitForDeploymentUrl(undefined, {
          project: "project-1",
          appName: "api",
        }).pipe(Effect.flip);
        const disabled = yield* waitForDeploymentUrl("https://app.prisma.build", {
          ...props,
          verifyUrl: false,
        }).pipe(Effect.flip);
        const missingClient = yield* waitForDeploymentUrl("https://app.prisma.build", props).pipe(
          Effect.flip,
        );

        expect(missingUrl.message).toContain("did not return");
        expect(missingRoutingUrl.message).toContain("readiness verification");
        expect(disabled.message).toContain("verifyUrl: false");
        expect(missingClient.message).toContain("HTTP client");
      }),
    );

    it.live("observes health redirects without following them", () => {
      const redirects: RequestRedirect[] = [];
      const fetch = (async (
        _input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        redirects.push(init?.redirect ?? "follow");
        return init?.redirect === "manual"
          ? new Response(null, { status: 302, headers: { location: "https://attacker.example/" } })
          : new Response(null, { status: 200 });
      }) as typeof globalThis.fetch;

      return Effect.gen(function* () {
        yield* waitForDeploymentUrl("https://app.prisma.build", {
          project: "project-1",
          appName: "api",
          healthCheck: { path: "/health", statusCodes: [302] },
          pollIntervalMs: 1,
          urlReadinessTimeoutSeconds: 0.05,
        });
        const defaultStatusError = yield* waitForDeploymentUrl("https://app.prisma.build", {
          project: "project-1",
          appName: "api",
          healthCheck: { path: "/health" },
          pollIntervalMs: 1,
          urlReadinessTimeoutSeconds: 0.01,
        }).pipe(Effect.flip);

        expect(redirects.length).toBeGreaterThanOrEqual(2);
        expect(redirects.every((redirect) => redirect === "manual")).toBe(true);
        expect(defaultStatusError.message).toContain("HTTP 302");
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
    });

    it.live("enforces one deadline for stalled requests and 404 bodies", () => {
      const stalledRequest = HttpClient.make(() => Effect.never);
      const stalledBody = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream<Uint8Array>({
                pull() {
                  // Deliberately never enqueue or close.
                },
              }),
              { status: 404 },
            ),
          ),
        ),
      );
      const props = {
        project: "project-1",
        appName: "api",
        pollIntervalMs: 1,
        urlReadinessTimeoutSeconds: 0.03,
      } as const;

      return Effect.gen(function* () {
        const requestError = yield* waitForDeploymentUrl(
          "https://request.prisma.build",
          props,
        ).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, stalledRequest)), Effect.flip);
        const bodyError = yield* waitForDeploymentUrl("https://body.prisma.build", props).pipe(
          Effect.provide(Layer.succeed(HttpClient.HttpClient, stalledBody)),
          Effect.flip,
        );

        expect(requestError.message).toContain("Timed out");
        expect(bodyError.message).toContain("Timed out");
      });
    });

    it.live("bounds the inspected prefix of a large Prisma edge 404", () => {
      let requests = 0;
      const hugeBody = `${"There is no service on this URL"}${"x".repeat(256 * 1024)}`;
      const http = HttpClient.make((request) => {
        requests += 1;
        return requests === 1
          ? Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(hugeBody, { status: 404 })),
            )
          : Effect.never;
      });

      return Effect.gen(function* () {
        const error = yield* waitForDeploymentUrl("https://missing.prisma.build", {
          project: "project-1",
          appName: "api",
          pollIntervalMs: 1,
          urlReadinessTimeoutSeconds: 0.05,
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, http)), Effect.flip);

        expect(error.message).toContain("There is no service on this URL");
        expect(requests).toBeGreaterThanOrEqual(1);
      });
    });

    it.effect("rejects invalid URL readiness timings before making a request", () => {
      const http = HttpClient.make(() => Effect.die("invalid readiness options must fail first"));

      return Effect.gen(function* () {
        const error = yield* waitForDeploymentUrl("https://app.prisma.build", {
          project: "project-1",
          appName: "api",
          pollIntervalMs: 0,
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, http)), Effect.flip);

        expect(error.message).toContain("pollIntervalMs");
      });
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
            { ...projectToken, id: "env-token-branch-2", branchId: "branch-2" },
            projectToken,
          ],
        ],
        [
          "REMOVE_ME",
          [{ ...projectRemove, id: "env-remove-branch", branchId: "branch-1" }, projectRemove],
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
            branchId: "branch-main",
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
          "project-1",
          "production",
          {
            API_URL: "https://example.test",
            TOKEN: Redacted.make("secret"),
            REMOVE_ME: null,
            SKIP_ME: undefined,
          },
          undefined,
          { TOKEN: "env-token", REMOVE_ME: "env-remove" },
        );

        expect(result).toEqual({
          synced: ["API_URL", "TOKEN"],
          deleted: ["REMOVE_ME"],
          ownedIds: { API_URL: "env-created", TOKEN: "env-token" },
        });
        expect(calls).toEqual([
          ["list", { projectId: "project-1", class: "production", key: "API_URL", limit: "100" }],
          ["list", { projectId: "project-1", class: "production", key: "TOKEN", limit: "100" }],
          ["list", { projectId: "project-1", class: "production", key: "REMOVE_ME", limit: "100" }],
          [
            "create",
            {
              projectId: "project-1",
              class: "production",
              key: "API_URL",
              value: "https://example.test",
            },
          ],
          ["update", { id: "env-token", input: { value: "secret" } }],
          ["delete", "env-remove"],
        ]);
      }).pipe(Effect.provide(apiRoutedHttp(client)));
    });

    it.effect("rolls back variables created by a partially failed env sync", () => {
      const calls: Array<[string, unknown]> = [];
      const createError = new Error("second create failed");
      const client = {
        listEnvironmentVariables: (query: unknown) => {
          calls.push(["list", query]);
          return Effect.succeed([]);
        },
        createEnvironmentVariable: (input: { key: string }) => {
          calls.push(["create", input]);
          return input.key === "A"
            ? Effect.succeed({
                id: "env-a",
                type: "environment-variable" as const,
                url: "https://api.prisma.test/v1/environment-variables/env-a",
                projectId: "project-1",
                branchId: null,
                class: "production" as const,
                key: "A",
                valueKid: "kid-a",
                isManagedBySystem: false,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
              })
            : Effect.fail(createError);
        },
        deleteEnvironmentVariable: (id: string) => {
          calls.push(["delete", id]);
          return Effect.void;
        },
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const error = yield* syncComputeEnvironment("project-1", "production", {
          A: "one",
          B: "two",
        }).pipe(Effect.flip);

        expect((error as Error).message).toContain("second create failed");
        expect(calls.map(([name]) => name)).toEqual(["list", "list", "create", "create", "delete"]);
        expect(calls).toContainEqual(["delete", "env-a"]);
      }).pipe(Effect.provide(apiRoutedHttp(client)));
    });

    it.effect("surfaces env rollback failures with manual cleanup routes", () => {
      const createError = new Error("second create failed");
      const cleanupError = new Error("rollback delete failed");
      const client = {
        listEnvironmentVariables: () => Effect.succeed([]),
        createEnvironmentVariable: (input: { key: string }) =>
          input.key === "A"
            ? Effect.succeed({
                id: "env-a",
                type: "environment-variable" as const,
                url: "https://api.prisma.test/v1/environment-variables/env-a",
                projectId: "project-1",
                branchId: null,
                class: "production" as const,
                key: "A",
                valueKid: "kid-a",
                isManagedBySystem: false,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
              })
            : Effect.fail(createError),
        deleteEnvironmentVariable: () => Effect.fail(cleanupError),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const error = yield* syncComputeEnvironment("project-1", "production", {
          A: "one",
          B: "two",
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(AggregateError);
        expect(((error as AggregateError).errors[0] as Error).message).toContain(
          "second create failed",
        );
        expect(((error as AggregateError).errors[1] as Error).message).toContain(
          "rollback delete failed",
        );
        expect((error as AggregateError).message).toContain(
          "DELETE /v1/environment-variables/env-a",
        );
      }).pipe(Effect.provide(apiRoutedHttp(client)));
    });

    it.effect("preflights foreign env ownership before any write", () => {
      const calls: string[] = [];
      const foreign = {
        id: "env-foreign",
        type: "environment-variable" as const,
        url: "https://api.prisma.test/v1/environment-variables/env-foreign",
        projectId: "project-1",
        branchId: null,
        class: "production" as const,
        key: "B",
        valueKid: "kid-foreign",
        isManagedBySystem: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      const client = {
        listEnvironmentVariables: (query: { key: string }) => {
          calls.push(`list:${query.key}`);
          return Effect.succeed(query.key === "B" ? [foreign] : []);
        },
        createEnvironmentVariable: () => {
          calls.push("create");
          return Effect.die("ownership preflight must happen first");
        },
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const error = yield* syncComputeEnvironment("project-1", "production", {
          A: "one",
          B: "two",
        }).pipe(Effect.flip);

        expect((error as Error).message).toContain("is not owned");
        expect(calls).toEqual(["list:A", "list:B"]);
      }).pipe(Effect.provide(apiRoutedHttp(client)));
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
        const error = yield* syncComputeEnvironment("project-1", "production", {
          PRISMA_INTERNAL_URL: "secret",
        }).pipe(Effect.flip);

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
              limit: "100",
            },
          ],
        ]);
      }).pipe(Effect.provide(apiRoutedHttp(client)));
    });

    it.effect("returns an empty tail stream before a deployment exists", () =>
      Effect.gen(function* () {
        const provider = yield* Provider.findProvider(Compute);
        const chunks = yield* Stream.runCollect(
          provider.tail!({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            props: { project: "project-1", appName: "api" },
            output: {
              appId: "service-1",
              deploymentId: undefined,
              projectId: "project-1",
              appName: "api",
              regionId: "us-east-1",
              deploymentEndpointDomain: undefined,
              deploymentUrl: undefined,
              appEndpointDomain: undefined,
              url: undefined,
              promoted: false,
              previousDeploymentId: undefined,
              previousDeploymentAction: undefined,
              artifactHash: undefined,
              local: false,
            },
          }),
        );

        expect(chunks).toEqual([]);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, {} as unknown as PrismaManagementClient)),
        Effect.provide(apiRoutedHttp({} as unknown as PrismaManagementClient)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      ),
    );

    it.effect("tails Compute logs through the provider", () =>
      withWebSocketServer((server) =>
        Effect.gen(function* () {
          const url = yield* listenUrl(server);
          let authorization: string | undefined;
          let requestUrl: string | undefined;

          server.on("connection", (socket, request) => {
            authorization = request.headers.authorization;
            requestUrl = request.url;
            socket.send(
              JSON.stringify({ type: "log", text: "compute app log", byteStart: 0, byteEnd: 15 }),
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

          const provider = yield* Provider.findProvider(Compute).pipe(
            Effect.provide(computeProviderLive()),
            Effect.provide(makeFakeManagementApi(unhandled).layer),
          );
          const lines = yield* provider.tail!({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            props: { project: "project-1", appName: "api" },
            output: {
              appId: "service-1",
              deploymentId: "version-1",
              projectId: "project-1",
              appName: "api",
              regionId: "us-east-1",
              deploymentEndpointDomain: "version-1.preview.prisma.build",
              deploymentUrl: "https://version-1.preview.prisma.build",
              appEndpointDomain: "api.prisma.build",
              url: "https://api.prisma.build",
              promoted: true,
              previousDeploymentId: undefined,
              previousDeploymentAction: undefined,
              artifactHash: Redacted.make("hash-1"),
              local: false,
            },
          }).pipe(
            // The carved-out logs client resolves the distilled Credentials
            // service directly: the test WebSocket server is the API base.
            Stream.provideService(
              Credentials,
              Effect.succeed({ apiToken: Redacted.make("app-token"), apiBaseUrl: url }),
            ),
            Stream.runCollect,
          );

          expect(lines.map((line) => line.message)).toEqual(["compute app log"]);
          expect(authorization).toBe("Bearer app-token");
          expect(requestUrl).toBe("/v1/deployments/version-1/logs");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(PlatformServices)),
      ),
    );
  },
);

/**
 * Fault injection through the engine: each suite deploys `Prisma.Compute`
 * against its own stateful fake Prisma cloud (see
 * `fixtures/ComputeFakeCloud.ts`) and injects the failure the real API
 * cannot produce on demand. Deployment IDs are assigned in creation order
 * (`version-1`, `version-2`, ...), so a baseline deploy owns `version-1`.
 */
const fakeTags = [
  "unit",
  "provider:prisma",
  "provider:prisma:compute",
  "provider:prisma:branch",
  "local",
];

const fakeSuite = () => {
  const cloud = makeFakeComputeCloud();
  const { test } = Test.make({ providers: fakeComputeProviders(cloud) });
  return { cloud, test };
};

type FakeAppProps = Omit<ComputeProps, "project" | "appName"> & { appName?: string };

const fakeApp = (props: FakeAppProps) =>
  Compute("App", { project: PROJECT_ID, appName: "api", ...props });

/** A deploy that only creates a deployment: no start, readiness, or promotion. */
const parked = { branchId: MAIN_BRANCH_ID, start: false, skipPromote: true } as const;

/** A promoted deploy whose readiness and observation waits fail fast. */
const health = {
  branchId: MAIN_BRANCH_ID,
  healthCheck: { path: "/health" },
  pollIntervalMs: 1,
  timeoutSeconds: 0.5,
  urlReadinessTimeoutSeconds: 0.05,
} as const;

const v1 = { artifactPath: fixtureArtifactV1Path, branchId: MAIN_BRANCH_ID } as const;
const v2 = { ...health, artifactPath: fixtureArtifactV2Path } as const;

const STABLE_HEALTH = "PROBE https://api.prisma.build/health";

/** Start a fake suite's test from an empty cloud and empty state. */
const fresh = (cloud: FakeComputeCloud, stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    cloud.reset();
    yield* stack.destroy();
  });

/** Clear injected faults, destroy, and require the cloud to be empty. */
const teardown = (cloud: FakeComputeCloud, stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    cloud.intercept = undefined;
    yield* stack.destroy();
    expect([...cloud.services.keys()]).toEqual([]);
    expect([...cloud.deployments.keys()]).toEqual([]);
  });

const hasError = (errors: ReadonlyArray<unknown>, text: string) =>
  errors.some((error) => error instanceof Error && error.message.includes(text));

const attachSuite = fakeSuite();
attachSuite.test.provider(
  "attaches a newly created App to its branch before creating a version",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = attachSuite;
      yield* fresh(cloud, stack);
      // Prisma can create the App without the requested branch attached.
      cloud.createServicesDetached = true;

      const output = yield* stack.deploy(fakeApp({ ...parked, artifactPath: fixtureArtifactPath }));

      expect(output.appId).toBe("service-1");
      expect(output.deploymentId).toBe("version-1");
      expect(
        cloud.captured.find((request) => isRoute(request, "POST", "/services"))?.bodyJson,
      ).toMatchObject({
        projectId: PROJECT_ID,
        displayName: "api",
        branchId: MAIN_BRANCH_ID,
      });
      expect(
        cloud.captured.find((request) => isRoute(request, "PATCH", "/services/service-1"))
          ?.bodyJson,
      ).toMatchObject({ displayName: "api", branchId: MAIN_BRANCH_ID });
      const patched = cloud.log.indexOf("PATCH /v1/services/service-1");
      expect(patched).toBeGreaterThan(-1);
      expect(cloud.log.indexOf("POST /v1/services/service-1/deployments")).toBeGreaterThan(patched);
      expect(cloud.services.get("service-1")?.branchId).toBe(MAIN_BRANCH_ID);

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const missingUploadUrlSuite = fakeSuite();
missingUploadUrlSuite.test.provider(
  "deletes the new deployment, but not the existing App, when Prisma omits an upload URL",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = missingUploadUrlSuite;
      yield* fresh(cloud, stack);
      yield* stack.deploy(fakeApp({ ...parked, artifactPath: fixtureArtifactV1Path }));

      cloud.omitUploadUrl = true;
      const mark = cloud.mark();
      const failed = yield* failureOf(
        stack.deploy(fakeApp({ ...parked, artifactPath: fixtureArtifactV2Path })),
      );

      expect(failed.text).toContain("did not return an upload URL");
      expect(cloud.since(mark)).toContain("DELETE /v1/deployments/version-2");
      expect(cloud.since(mark)).not.toContain("DELETE /v1/services/service-1");
      expect(cloud.deployments.has("version-2")).toBe(false);
      expect(cloud.services.has("service-1")).toBe(true);

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const createCleanupSuite = fakeSuite();
createCleanupSuite.test.provider(
  "deletes a newly created App when a later create step fails",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = createCleanupSuite;
      yield* fresh(cloud, stack);
      cloud.omitUploadUrl = true;

      const failed = yield* failureOf(
        stack.deploy(fakeApp({ ...parked, artifactPath: fixtureArtifactPath })),
      );

      expect(failed.text).toContain("did not return an upload URL");
      expect(cloud.log).toContain("DELETE /v1/deployments/version-1");
      expect(cloud.log).toContain("DELETE /v1/services/service-1");
      expect([...cloud.services.keys()]).toEqual([]);

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const uploadSuite = fakeSuite();
uploadSuite.test.provider(
  "uploads an artifactPath archive and deletes the deployment when the upload fails",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = uploadSuite;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fresh(cloud, stack);
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-prisma-artifact-" });
      const artifactPath = path.join(root, "app.tar.gz");
      yield* fs.writeFileString(artifactPath, "prebuilt-archive");

      const first = yield* stack.deploy(fakeApp({ ...parked, artifactPath }));

      expect(first.deploymentId).toBe("version-1");
      expect(cloud.uploads).toHaveLength(1);
      expect(cloud.uploads[0]?.url).toBe("https://upload.prisma.test/version-1.tar.gz");
      expect(cloud.uploads[0]?.contentType).toBe("application/gzip");
      expect(new TextDecoder().decode(cloud.uploads[0]?.bytes)).toBe("prebuilt-archive");

      cloud.uploadStatus = 500;
      const mark = cloud.mark();
      const failed = yield* failureOf(
        stack.deploy(fakeApp({ ...parked, artifactPath: fixtureArtifactV2Path })),
      );

      expect(failed.text).toContain("artifact upload failed");
      expect(cloud.since(mark)).toContain("DELETE /v1/deployments/version-2");
      expect(cloud.deployments.has("version-2")).toBe(false);
      expect(cloud.deployments.has("version-1")).toBe(true);

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const startSuite = fakeSuite();
startSuite.test.provider(
  "deletes the created deployment when start fails",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = startSuite;
      yield* fresh(cloud, stack);
      yield* stack.deploy(fakeApp(v1));

      cloud.intercept = (request) =>
        isRoute(request, "POST", "/deployments/version-2/start")
          ? rejected("start failed")
          : undefined;
      const mark = cloud.mark();
      const failed = yield* failureOf(
        stack.deploy(fakeApp({ artifactPath: fixtureArtifactV2Path, branchId: MAIN_BRANCH_ID })),
      );

      // Over the wire the injected failure decodes into the typed error.
      expect(
        failed.errors.some(
          (error) => error instanceof BadRequest && error.message === "start failed",
        ),
      ).toBe(true);
      expect(cloud.since(mark)).toContain("DELETE /v1/deployments/version-2");
      expect(cloud.services.get("service-1")?.latestDeploymentId).toBe("version-1");

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const identitySuite = fakeSuite();
identitySuite.test.provider(
  "refuses a persisted App with mismatched immutable identity",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = identitySuite;
      yield* fresh(cloud, stack);
      yield* stack.deploy(fakeApp({ ...parked, artifactPath: fixtureArtifactV1Path }));

      cloud.services.get("service-1")!.projectId = "project-other";
      const mark = cloud.mark();
      const failed = yield* failureOf(
        stack.deploy(fakeApp({ ...parked, artifactPath: fixtureArtifactV2Path })),
      );

      expect(failed.text).toContain("project-other");
      expect(failed.text).toContain("Refusing to patch");
      // Observed, then refused: no patch and no deployment.
      expect(cloud.since(mark)).toEqual(["GET /v1/services/service-1"]);

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const previewHealthSuite = fakeSuite();
previewHealthSuite.test.provider(
  "blocks promotion and deletes a new deployment when preview health fails",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = previewHealthSuite;
      yield* fresh(cloud, stack);
      yield* stack.deploy(fakeApp(v1));

      cloud.previewStatus = 503;
      const mark = cloud.mark();
      const failed = yield* failureOf(stack.deploy(fakeApp(v2)));
      const calls = cloud.since(mark);

      expect(failed.text).toContain("https://version-2.preview.prisma.build/health");
      expect(failed.text).toContain("HTTP 503");
      expect(calls).not.toContain("POST /v1/services/service-1/promote");
      expect(calls).toContain("POST /v1/deployments/version-2/stop");
      expect(calls).toContain("DELETE /v1/deployments/version-2");
      expect(cloud.deployments.has("version-2")).toBe(false);
      expect(cloud.deployments.has("version-1")).toBe(true);
      expect(cloud.services.get("service-1")?.latestDeploymentId).toBe("version-1");

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const stableHealthSuite = fakeSuite();
stableHealthSuite.test.provider(
  "rolls back promotion and deletes the new deployment when stable health fails",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = stableHealthSuite;
      yield* fresh(cloud, stack);
      yield* stack.deploy(fakeApp(v1));

      cloud.stableStatus = 503;
      const mark = cloud.mark();
      const failed = yield* failureOf(stack.deploy(fakeApp(v2)));
      const calls = cloud.since(mark);

      expect(failed.text).toContain("https://api.prisma.build/health");
      expect(failed.text).toContain("HTTP 503");
      const promoted = calls.indexOf("POST /v1/services/service-1/promote");
      const rolledBack = calls.indexOf("POST /v1/services/service-1/rollback");
      const deleted = calls.indexOf("DELETE /v1/deployments/version-2");
      expect(promoted).toBeGreaterThan(-1);
      expect(rolledBack).toBeGreaterThan(promoted);
      expect(deleted).toBeGreaterThan(rolledBack);
      expect(
        cloud.captured.find((request) => isRoute(request, "POST", "/services/service-1/rollback"))
          ?.bodyJson,
      ).toEqual({ deploymentId: "version-1" });
      expect(cloud.deployments.has("version-2")).toBe(false);
      expect(cloud.deployments.has("version-1")).toBe(true);
      expect(cloud.services.get("service-1")?.latestDeploymentId).toBe("version-1");

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const promotionDriftSuite = fakeSuite();
promotionDriftSuite.test.provider(
  "does not probe stable health after a successful promotion response that does not converge",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = promotionDriftSuite;
      yield* fresh(cloud, stack);
      yield* stack.deploy(fakeApp(v1));

      cloud.promoteUpdatesLatest = false;
      const mark = cloud.mark();
      const failed = yield* failureOf(stack.deploy(fakeApp(v2)));
      const calls = cloud.since(mark);

      expect(failed.errors.some((error) => error instanceof AggregateError)).toBe(true);
      expect(hasError(failed.errors, "promotion returned success")).toBe(true);
      expect(hasError(failed.errors, "did not converge")).toBe(true);
      expect(cloud.services.get("service-1")?.latestDeploymentId).toBe("version-1");
      expect(cloud.deployments.has("version-2")).toBe(true);
      expect(calls).not.toContain(STABLE_HEALTH);
      expect(calls.filter((call) => call.startsWith("DELETE /v1/deployments"))).toEqual([]);

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const rollbackDriftSuite = fakeSuite();
rollbackDriftSuite.test.provider(
  "does not delete a promoted deployment after a successful rollback response that does not converge",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = rollbackDriftSuite;
      yield* fresh(cloud, stack);
      yield* stack.deploy(fakeApp(v1));

      cloud.stableStatus = 503;
      cloud.rollbackUpdatesLatest = false;
      const mark = cloud.mark();
      const failed = yield* failureOf(stack.deploy(fakeApp(v2)));

      expect(failed.errors.some((error) => error instanceof AggregateError)).toBe(true);
      expect(hasError(failed.errors, "rollback to deployment 'version-1' did not converge")).toBe(
        true,
      );
      expect(cloud.services.get("service-1")?.latestDeploymentId).toBe("version-2");
      expect(cloud.deployments.has("version-2")).toBe(true);
      expect(cloud.deployments.has("version-1")).toBe(true);
      expect(cloud.since(mark).filter((call) => call.startsWith("DELETE /v1/deployments"))).toEqual(
        [],
      );

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const hashMatchingFailedSuite = fakeSuite();
hashMatchingFailedSuite.test.provider(
  "replaces a hash-matching terminal failed deployment before cleaning it",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = hashMatchingFailedSuite;
      yield* fresh(cloud, stack);
      const news = { ...health, artifactPath: fixtureArtifactV1Path };
      yield* stack.deploy(fakeApp(news));

      cloud.deployments.get("version-1")!.status = "failed";
      const mark = cloud.mark();
      const recovered = yield* stack.deploy(fakeApp(news));
      const calls = cloud.since(mark);

      expect(recovered.deploymentId).toBe("version-2");
      expect(recovered.promoted).toBe(true);
      expect(recovered.readinessStatus).toBe("ready");
      expect(recovered.previousDeploymentId).toBe("version-1");
      expect(recovered.previousDeploymentAction).toBe("destroyed");
      const created = calls.indexOf("POST /v1/services/service-1/deployments");
      const stableHealth = calls.indexOf(STABLE_HEALTH);
      const failedDeleted = calls.indexOf("DELETE /v1/deployments/version-1");
      expect(created).toBeGreaterThan(-1);
      expect(stableHealth).toBeGreaterThan(created);
      expect(failedDeleted).toBeGreaterThan(stableHealth);
      // A terminal failed deployment is never restarted.
      expect(calls).not.toContain("POST /v1/deployments/version-1/start");
      expect(cloud.deployments.has("version-1")).toBe(false);
      expect(cloud.deployments.has("version-2")).toBe(true);

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const changedHashFailedSuite = fakeSuite();
changedHashFailedSuite.test.provider(
  "destroys a changed-hash terminal failed deployment only after replacement convergence",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = changedHashFailedSuite;
      yield* fresh(cloud, stack);
      yield* stack.deploy(fakeApp(v1));

      cloud.deployments.get("version-1")!.status = "failed";
      const mark = cloud.mark();
      const output = yield* stack.deploy(fakeApp(v2));
      const calls = cloud.since(mark);

      expect(output.deploymentId).toBe("version-2");
      expect(output.previousDeploymentId).toBe("version-1");
      expect(output.previousDeploymentAction).toBe("destroyed");
      const stableHealth = calls.indexOf(STABLE_HEALTH);
      expect(stableHealth).toBeGreaterThan(-1);
      expect(calls.indexOf("DELETE /v1/deployments/version-1")).toBeGreaterThan(stableHealth);
      expect(calls).not.toContain("POST /v1/deployments/version-1/stop");
      expect(cloud.deployments.has("version-1")).toBe(false);
      expect(cloud.deployments.has("version-2")).toBe(true);

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const failedRollbackTargetSuite = fakeSuite();
failedRollbackTargetSuite.test.provider(
  "never rolls back to a changed-hash terminal failed deployment and blocks duplicate retry creation",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = failedRollbackTargetSuite;
      yield* fresh(cloud, stack);
      yield* stack.deploy(fakeApp(v1));

      cloud.deployments.get("version-1")!.status = "failed";
      cloud.stableStatus = 503;
      const first = yield* failureOf(stack.deploy(fakeApp(v2)));

      expect(first.errors.some((error) => error instanceof AggregateError)).toBe(true);
      expect(hasError(first.errors, "no safe rollback target exists")).toBe(true);
      expect(cloud.log).not.toContain("POST /v1/services/service-1/rollback");
      expect(cloud.services.get("service-1")?.latestDeploymentId).toBe("version-2");
      expect(cloud.deployments.has("version-1")).toBe(true);
      expect(cloud.deployments.has("version-2")).toBe(true);

      cloud.stableStatus = 204;
      const mark = cloud.mark();
      const retry = yield* failureOf(stack.deploy(fakeApp(v2)));
      const retryCalls = cloud.since(mark);

      expect(
        hasError(
          retry.errors,
          "cannot prove that the live deployment is the interrupted replacement",
        ),
      ).toBe(true);
      expect(retryCalls).not.toContain("POST /v1/services/service-1/deployments");
      expect(retryCalls).not.toContain("POST /v1/services/service-1/rollback");
      expect(retryCalls.filter((call) => call.startsWith("DELETE"))).toEqual([]);
      expect(cloud.services.get("service-1")?.latestDeploymentId).toBe("version-2");
      expect(cloud.deployments.has("version-1")).toBe(true);
      expect(cloud.deployments.has("version-2")).toBe(true);

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const lostRollbackTargetSuite = fakeSuite();
lostRollbackTargetSuite.test.provider(
  "does not create another generation after failed terminal replacement loses a safe rollback target",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = lostRollbackTargetSuite;
      yield* fresh(cloud, stack);
      const news = { ...health, artifactPath: fixtureArtifactV1Path };
      yield* stack.deploy(fakeApp(news));

      cloud.deployments.get("version-1")!.status = "failed";
      cloud.stableStatus = 503;
      const replacement = yield* failureOf(stack.deploy(fakeApp(news)));

      expect(hasError(replacement.errors, "no safe rollback target exists")).toBe(true);
      expect(cloud.services.get("service-1")?.latestDeploymentId).toBe("version-2");
      expect(cloud.deployments.has("version-1")).toBe(true);
      expect(cloud.deployments.has("version-2")).toBe(true);
      expect(cloud.log.filter((call) => call.startsWith("DELETE"))).toEqual([]);

      cloud.stableStatus = 204;
      const mark = cloud.mark();
      const retry = yield* failureOf(stack.deploy(fakeApp(news)));
      const retryCalls = cloud.since(mark);

      expect(
        hasError(
          retry.errors,
          "cannot prove that the live deployment is the interrupted replacement",
        ),
      ).toBe(true);
      expect(retryCalls).not.toContain("POST /v1/services/service-1/deployments");
      expect(retryCalls.filter((call) => call.startsWith("DELETE"))).toEqual([]);
      expect(cloud.services.get("service-1")?.latestDeploymentId).toBe("version-2");

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const rollbackRecoverySuite = fakeSuite();
rollbackRecoverySuite.test.provider(
  "fails closed on rollback failure and recovers from persisted state before retrying",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = rollbackRecoverySuite;
      yield* fresh(cloud, stack);
      yield* stack.deploy(fakeApp(v1));

      let rollbackFailures = 2;
      cloud.intercept = (request) => {
        if (!isRoute(request, "POST", "/services/service-1/rollback") || rollbackFailures === 0) {
          return undefined;
        }
        rollbackFailures -= 1;
        return rejected("rollback unavailable");
      };
      cloud.stableStatus = 503;
      const first = yield* failureOf(stack.deploy(fakeApp(v2)));

      expect(hasError(first.errors, "promoted deployment 'version-2'")).toBe(true);
      expect(hasError(first.errors, "rollback to deployment 'version-1' did not converge")).toBe(
        true,
      );
      expect(hasError(first.errors, "next reconcile will retry recovery")).toBe(true);
      expect(cloud.services.get("service-1")?.latestDeploymentId).toBe("version-2");
      expect(cloud.deployments.has("version-1")).toBe(true);
      expect(cloud.deployments.has("version-2")).toBe(true);
      expect(cloud.log.filter((call) => call.startsWith("DELETE"))).toEqual([]);

      // The persisted state still names version-1 as the promoted generation,
      // so the retry must restore it before changing anything else.
      cloud.stableStatus = 204;
      const blockedMark = cloud.mark();
      const blocked = yield* failureOf(stack.deploy(fakeApp(v2)));

      expect(
        hasError(blocked.errors, "no environment variables or new deployment were changed"),
      ).toBe(true);
      expect(
        blocked.errors.some(
          (error) =>
            error instanceof AggregateError &&
            error.errors.some(
              (inner) => inner instanceof BadRequest && inner.message === "rollback unavailable",
            ),
        ),
      ).toBe(true);
      expect(cloud.since(blockedMark)).not.toContain("POST /v1/services/service-1/deployments");
      expect(cloud.services.get("service-1")?.latestDeploymentId).toBe("version-2");

      const recoveryMark = cloud.mark();
      const recovered = yield* stack.deploy(fakeApp(v2));
      const recovery = cloud.since(recoveryMark);

      expect(recovered.deploymentId).toBe("version-3");
      expect(recovered.promoted).toBe(true);
      expect(recovered.readinessStatus).toBe("ready");
      const rolledBack = recovery.indexOf("POST /v1/services/service-1/rollback");
      const displacedDeleted = recovery.indexOf("DELETE /v1/deployments/version-2");
      const replacementCreated = recovery.indexOf("POST /v1/services/service-1/deployments");
      expect(rolledBack).toBeGreaterThan(-1);
      expect(displacedDeleted).toBeGreaterThan(rolledBack);
      expect(replacementCreated).toBeGreaterThan(displacedDeleted);
      expect(cloud.deployments.has("version-2")).toBe(false);
      expect(cloud.deployments.has("version-3")).toBe(true);
      expect(cloud.services.get("service-1")?.latestDeploymentId).toBe("version-3");
      expect(
        cloud.log.filter((call) => call === "POST /v1/services/service-1/deployments"),
      ).toHaveLength(3);

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const customStatusSuite = fakeSuite();
customStatusSuite.test.provider(
  "honors custom accepted health statuses before and after promotion",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = customStatusSuite;
      yield* fresh(cloud, stack);
      cloud.previewStatus = 302;
      cloud.stableStatus = 302;

      const output = yield* stack.deploy(
        fakeApp({
          ...v2,
          healthCheck: { path: "/ready", statusCodes: [302] },
        }),
      );

      expect(output.deploymentId).toBe("version-1");
      expect(output.promoted).toBe(true);
      expect(output.readinessStatus).toBe("ready");
      expect(cloud.probes).toEqual([
        "https://version-1.preview.prisma.build/ready",
        "https://api.prisma.build/ready",
      ]);
      expect(cloud.log).not.toContain("POST /v1/services/service-1/rollback");
      expect(cloud.log.filter((call) => call.startsWith("DELETE"))).toEqual([]);

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const foreignServiceSuite = fakeSuite();
foreignServiceSuite.test.provider(
  "refuses to claim a foreign App after a create conflict",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = foreignServiceSuite;
      yield* fresh(cloud, stack);
      // Another actor creates the same App between our lookup and our create.
      cloud.intercept = (request) => {
        if (!isRoute(request, "POST", "/services")) return undefined;
        cloud.services.set("service-foreign", {
          id: "service-foreign",
          name: "api",
          projectId: PROJECT_ID,
          regionId: "us-east-1",
          branchId: MAIN_BRANCH_ID,
          latestDeploymentId: null,
          appEndpointDomain: "api.prisma.build",
        });
        return conflict("already exists");
      };

      const failed = yield* failureOf(
        stack.deploy(
          fakeApp({ artifactPath: fixtureArtifactPath, start: false, skipPromote: true }),
        ),
      );

      expect(failed.text).toContain("is not owned");
      expect(cloud.log).not.toContain("POST /v1/services/service-foreign/deployments");

      // Destroy recovers the interrupted create, finds the App unowned, and
      // leaves it in place.
      cloud.intercept = undefined;
      yield* stack.destroy();
      expect(cloud.services.has("service-foreign")).toBe(true);
      expect(cloud.log).not.toContain("DELETE /v1/services/service-foreign");
    }),
  { tags: fakeTags },
);

const updatesSuite = fakeSuite();
updatesSuite.test.provider(
  "reconciles deploy updates and destroys old deployments",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = updatesSuite;
      yield* fresh(cloud, stack);
      const base = { artifactPath: fixtureArtifactV1Path, port: 3000 } as const;

      const first = yield* stack.deploy(fakeApp(base));
      expect(first.deploymentId).toBe("version-1");
      expect(first.promoted).toBe(true);
      expect(
        cloud.captured.find((request) =>
          isRoute(request, "POST", "/services/service-1/deployments"),
        )?.bodyJson,
      ).toEqual({ portMapping: { http: 3000 } });
      // The default branch is resolved when no branch is given.
      expect(cloud.log).toContain(`GET /v1/projects/${PROJECT_ID}/branches`);

      // Skipping promotion of an unchanged artifact reuses the live deployment.
      const skipMark = cloud.mark();
      const skipped = yield* stack.deploy(fakeApp({ ...base, skipPromote: true }));
      expect(skipped.deploymentId).toBe("version-1");
      expect(skipped.promoted).toBe(true);
      expect(skipped.url).toBe("https://api.prisma.build");
      expect(cloud.since(skipMark)).not.toContain("POST /v1/services/service-1/deployments");
      expect(cloud.since(skipMark)).not.toContain("POST /v1/services/service-1/promote");

      // The old deployment vanishes mid-cleanup; destroy still converges.
      cloud.intercept = (request) => {
        if (!isRoute(request, "POST", "/deployments/version-1/stop")) return undefined;
        cloud.deployments.delete("version-1");
        return notFound("not found");
      };
      const second = yield* stack.deploy(
        fakeApp({ ...base, artifactPath: fixtureArtifactV2Path, destroyOldDeployment: true }),
      );
      expect(second.deploymentId).toBe("version-2");
      expect(second.previousDeploymentId).toBe("version-1");
      expect(second.previousDeploymentAction).toBe("destroyed");
      expect([...cloud.deployments.keys()]).toEqual(["version-2"]);

      yield* teardown(cloud, stack);
      expect(cloud.log).toContain("DELETE /v1/services/service-1");
    }),
  { tags: fakeTags },
);

const replayPromotionSuite = fakeSuite();
replayPromotionSuite.test.provider(
  "replays promotion to repair endpoint drift for a matching deployment",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = replayPromotionSuite;
      yield* fresh(cloud, stack);
      const news = { ...v1, artifactPath: fixtureArtifactPath, verifyUrl: false } as const;

      const first = yield* stack.deploy(fakeApp(news));
      const second = yield* stack.deploy(fakeApp(news));

      expect(first.deploymentId).toBe("version-1");
      expect(second.deploymentId).toBe("version-1");
      expect(second.previousDeploymentId).toBeNull();
      const promotions = cloud.captured.filter((request) =>
        isRoute(request, "POST", "/services/service-1/promote"),
      );
      expect(promotions.map((request) => request.bodyJson)).toEqual([
        { deploymentId: "version-1" },
        { deploymentId: "version-1" },
      ]);
      expect(
        cloud.log.filter((call) => call === "POST /v1/services/service-1/deployments"),
      ).toHaveLength(1);

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const pendingCleanupSuite = fakeSuite();
pendingCleanupSuite.test.provider(
  "persists pending cleanup when destroying the old deployment fails, then drains it",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = pendingCleanupSuite;
      yield* fresh(cloud, stack);
      yield* stack.deploy(fakeApp({ ...v1, port: 3000 }));

      cloud.intercept = (request) =>
        isRoute(request, "DELETE", "/deployments/version-1")
          ? rejected("Internal Server Error")
          : undefined;
      const news = {
        artifactPath: fixtureArtifactV2Path,
        branchId: MAIN_BRANCH_ID,
        port: 3000,
        destroyOldDeployment: true,
      } as const;
      const output = yield* stack.deploy(fakeApp(news));

      expect(output.deploymentId).toBe("version-2");
      expect(output.previousDeploymentAction).toBe("still-active");
      expect(output.pendingDeploymentCleanup).toEqual({
        deploymentId: "version-1",
        action: "destroy",
      });
      expect(cloud.log).toContain("DELETE /v1/deployments/version-1");
      expect(cloud.deployments.has("version-1")).toBe(true);

      // The next reconcile drains the pending cleanup before anything else.
      cloud.intercept = undefined;
      const drained = yield* stack.deploy(fakeApp(news));
      expect(drained.deploymentId).toBe("version-2");
      expect(drained.pendingDeploymentCleanup).toBeUndefined();
      expect(cloud.deployments.has("version-1")).toBe(false);

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const ambiguousPromotionSuite = fakeSuite();
ambiguousPromotionSuite.test.provider(
  "preserves a newly created deployment when promotion commit is ambiguous",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = ambiguousPromotionSuite;
      yield* fresh(cloud, stack);
      yield* stack.deploy(fakeApp({ ...parked, artifactPath: fixtureArtifactV1Path }));

      cloud.intercept = (request) =>
        isRoute(request, "POST", "/services/service-1/promote")
          ? rejected("promote failed")
          : isRoute(request, "POST", "/services/service-1/rollback")
            ? rejected("promotion recovery failed")
            : undefined;
      const mark = cloud.mark();
      const failed = yield* failureOf(
        stack.deploy(fakeApp({ artifactPath: fixtureArtifactV2Path, branchId: MAIN_BRANCH_ID })),
      );
      const calls = cloud.since(mark);

      expect(
        failed.errors.some(
          (error) => error instanceof AggregateError && error.message.includes("ambiguous"),
        ),
      ).toBe(true);
      expect(calls).toContain("POST /v1/services/service-1/promote");
      expect(calls).toContain("POST /v1/services/service-1/rollback");
      expect(calls.filter((call) => call.startsWith("DELETE"))).toEqual([]);
      expect(cloud.deployments.get("version-2")?.status).toBe("running");
      expect(cloud.services.get("service-1")?.latestDeploymentId).toBeNull();

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const driftSuite = fakeSuite();
driftSuite.test.provider(
  "drift reports the stored deployment unpromoted when the live latest differs",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = driftSuite;
      yield* fresh(cloud, stack);
      yield* stack.deploy(fakeApp(v1));
      const stored = yield* stack.deploy(fakeApp({ ...v1, artifactPath: fixtureArtifactV2Path }));
      expect(stored.deploymentId).toBe("version-2");
      expect(stored.promoted).toBe(true);

      // Another actor rolls the App back to the previous deployment.
      cloud.services.get("service-1")!.latestDeploymentId = "version-1";
      const mark = cloud.mark();
      const detected = yield* Drift.detect({ name: stack.name, stage: stack.stage }).pipe(
        Effect.provide(stack.state),
      );

      expect(detected.resources.App).toMatchObject({
        action: "drifted",
        attr: {
          appId: "service-1",
          deploymentId: "version-2",
          promoted: false,
          deploymentEndpointDomain: "version-2.preview.prisma.build",
          url: "https://version-2.preview.prisma.build",
        },
      });
      // Read through the persisted App and deployment, not a project listing.
      expect(cloud.since(mark)).toEqual([
        "GET /v1/services/service-1",
        "GET /v1/deployments/version-2",
        "GET /v1/services/service-1/deployments",
      ]);

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const systemEnvSuite = fakeSuite();
systemEnvSuite.test.provider(
  "skips system-managed Compute env vars on destroy",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = systemEnvSuite;
      yield* fresh(cloud, stack);
      const output = yield* stack.deploy(
        fakeApp({
          ...parked,
          artifactPath: fixtureArtifactPath,
          env: { TOKEN: Redacted.make("secret"), PRISMA_INTERNAL_URL: "prisma-owned" },
        }),
      );
      const ids = output.environmentVariableIds!;
      expect(Object.keys(ids).sort()).toEqual(["PRISMA_INTERNAL_URL", "TOKEN"]);

      // Prisma takes the variable over after Alchemy created it.
      cloud.environmentVariables.get(ids.PRISMA_INTERNAL_URL!)!.isManagedBySystem = true;
      const mark = cloud.mark();
      yield* stack.destroy();

      expect(cloud.since(mark).filter((call) => call.startsWith("DELETE"))).toEqual([
        `DELETE /v1/environment-variables/${ids.TOKEN}`,
        "DELETE /v1/services/service-1",
      ]);
      expect([...cloud.environmentVariables.keys()]).toEqual([ids.PRISMA_INTERNAL_URL]);
      expect([...cloud.services.keys()]).toEqual([]);
    }),
  { tags: fakeTags },
);

const tombstoneSuite = fakeSuite();
tombstoneSuite.test.provider(
  "deletes persisted env keys on destroy even when props contain null tombstones",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = tombstoneSuite;
      yield* fresh(cloud, stack);
      yield* stack.deploy(
        fakeApp({ ...parked, artifactPath: fixtureArtifactPath, env: { STALE_FLAG: null } }),
      );
      // State recorded ownership of a variable the props now tombstone.
      cloud.environmentVariables.set("env-stale", {
        id: "env-stale",
        projectId: PROJECT_ID,
        branchId: null,
        class: "production",
        key: "STALE_FLAG",
        value: "stale",
        isManagedBySystem: false,
      });
      yield* patchStateAttr(stack, "App", { environmentVariableIds: { STALE_FLAG: "env-stale" } });

      const mark = cloud.mark();
      yield* stack.destroy();

      expect(cloud.since(mark).filter((call) => call.startsWith("DELETE"))).toEqual([
        "DELETE /v1/environment-variables/env-stale",
        "DELETE /v1/services/service-1",
      ]);
      expect(cloud.environmentVariables.size).toBe(0);
    }),
  { tags: fakeTags },
);

const missingEnvSuite = fakeSuite();
missingEnvSuite.test.provider(
  "continues Compute destroy when managed env vars are already gone",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = missingEnvSuite;
      yield* fresh(cloud, stack);
      yield* stack.deploy(
        fakeApp({ ...parked, artifactPath: fixtureArtifactPath, env: { TOKEN: "secret" } }),
      );

      cloud.intercept = (request) =>
        isRoute(request, "GET", "/environment-variables")
          ? notFound("project not found")
          : undefined;
      const mark = cloud.mark();
      yield* stack.destroy();

      expect(cloud.since(mark)).toEqual([
        "GET /v1/environment-variables",
        "DELETE /v1/services/service-1",
      ]);
      expect([...cloud.services.keys()]).toEqual([]);
    }),
  { tags: fakeTags },
);

const frameworkPortSuite = fakeSuite();
frameworkPortSuite.test.provider(
  "uses framework auto-build default ports in Compute",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = frameworkPortSuite;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fresh(cloud, stack);
      const root = yield* fs.makeTempDirectoryScoped({
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

      const output = yield* stack.deploy(
        fakeApp({
          ...parked,
          appName: "web",
          path: root,
          build: { type: "auto", framework: "nextjs" },
        }),
      );

      expect(output.deploymentId).toBe("version-1");
      expect(
        cloud.captured.find((request) =>
          isRoute(request, "POST", "/services/service-1/deployments"),
        )?.bodyJson,
      ).toEqual({ portMapping: { http: 3000 } });
      const tar = new TextDecoder().decode(
        yield* Effect.sync(() => gunzipSync(cloud.uploads[0]!.bytes)),
      );
      expect(tar).toContain("next server");

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

/** Write an effect-native Compute module whose `fetch` answers `body`. */
const writeEffectMain = (prefix: string, exportLine: string, props: string[], body: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix });
    const main = path.join(root, "app.ts");
    yield* fs.writeFileString(
      main,
      [
        'import * as Prisma from "alchemy/Prisma";',
        'import * as Effect from "effect/Effect";',
        'import * as HttpServerResponse from "effect/http/HttpServerResponse";',
        "",
        `${exportLine} Prisma.Compute(`,
        '  "App",',
        "  {",
        `    project: "${PROJECT_ID}",`,
        '    appName: "api",',
        "    main: import.meta.filename,",
        ...props.map((prop) => `    ${prop},`),
        "  },",
        "  Effect.gen(function* () {",
        "    return {",
        `      fetch: HttpServerResponse.text(${JSON.stringify(body)}),`,
        "    };",
        "  }),",
        ");",
        "",
      ].join("\n"),
    );
    return main;
  });

const effectNativeSuite = fakeSuite();
effectNativeSuite.test.provider(
  "bundles effect-native Compute apps into an upload artifact",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = effectNativeSuite;
      yield* fresh(cloud, stack);
      const main = yield* writeEffectMain(
        "alchemy-prisma-compute-effect-",
        "export default",
        ["port: 4555"],
        "effect-native-ok",
      );

      // Only `main` is bundled; the inline implementation here is not.
      const output = yield* stack.deploy(
        Compute(
          "App",
          { project: PROJECT_ID, appName: "api", main, port: 4555, ...parked },
          Effect.void,
        ),
      );

      expect(output.deploymentId).toBe("version-1");
      expect(cloud.uploads[0]?.url).toBe("https://upload.prisma.test/version-1.tar.gz");
      expect(cloud.uploads[0]?.contentType).toBe("application/gzip");
      const tar = yield* Effect.sync(() => gunzipSync(cloud.uploads[0]!.bytes));
      const manifest = readTarFile(tar, "compute.manifest.json");
      const bundle = readTarFile(tar, "bundle/index.js");
      expect(JSON.parse(manifest)).toMatchObject({ entrypoint: "bundle/index.js" });
      // The generated entry is a shim over alchemy/Runtime/Bootstrap/Prisma;
      // its label and the shared "bootstrap starting" message are separate
      // literals joined at runtime (see Runtime/Bootstrap/Process.ts).
      expect(bundle).toContain("Prisma Compute");
      expect(bundle).toContain("bootstrap starting");
      expect(bundle).toMatch(/hostname\s*:\s*["'`]0\.0\.0\.0["'`]/);
      // The deploy-time stack identity is baked into the artifact.
      expect(bundle).toContain(stack.name);
      expect(bundle).toContain(stack.stage);
      expect(bundle).toContain("ALCHEMY_PHASE");
      expect(bundle).toContain("effect-native-ok");
      expect(
        cloud.captured.find((request) =>
          isRoute(request, "POST", "/services/service-1/deployments"),
        )?.bodyJson,
      ).toEqual({ portMapping: { http: 4555 } });

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const namedExportSuite = fakeSuite();
namedExportSuite.test.provider(
  "bundles effect-native Compute apps from a named export",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = namedExportSuite;
      yield* fresh(cloud, stack);
      const main = yield* writeEffectMain(
        "alchemy-prisma-compute-named-effect-",
        "export const Api =",
        ['handler: "Api"'],
        "named-handler-ok",
      );

      const output = yield* stack.deploy(
        Compute(
          "App",
          { project: PROJECT_ID, appName: "api", main, handler: "Api", ...parked },
          Effect.void,
        ),
      );

      expect(output.deploymentId).toBe("version-1");
      const tar = new TextDecoder().decode(
        yield* Effect.sync(() => gunzipSync(cloud.uploads[0]!.bytes)),
      );
      expect(tar).toContain("compute.manifest.json");
      expect(tar).toContain("named-handler-ok");

      yield* teardown(cloud, stack);
    }),
  { tags: fakeTags },
);

const dev = Test.make({ providers: Prisma.providers(), dev: true });

dev.test.provider(
  "dev provider applies the same Compute prop validation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const failed = yield* failureOf(
        stack.deploy(
          Compute("App", {
            project: "project-dev",
            appName: "api",
            skipPromote: true,
            destroyOldDeployment: true,
            dev: { url: "http://localhost:3000" },
          }),
        ),
      );

      expect(failed.text).toContain("destroyOldDeployment cannot be combined with skipPromote");

      yield* stack.destroy();
    }),
  { tags: ["unit", "provider:prisma", "provider:prisma:compute", "local"] },
);

const withWebSocketServer = <A, E, R>(f: (server: WebSocketServer) => Effect.Effect<A, E, R>) =>
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
        resume(Effect.succeed(`http://127.0.0.1:${address.port}`));
      } else {
        resume(Effect.fail(new Error("WebSocket server has no TCP address")));
      }
    };
    const fail = (cause: unknown) => {
      cleanup();
      resume(Effect.fail(cause instanceof Error ? cause : new Error(String(cause))));
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
