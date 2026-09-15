import { AlchemyContext } from "@/AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "@/Artifacts.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import type { ContainerApplication } from "@/Cloudflare/Containers/ContainerApplication.ts";
import { ContainerPlatform } from "@/Cloudflare/Containers/ContainerPlatform.ts";
import { LiveContainerProvider } from "@/Cloudflare/Containers/ContainerProvider.ts";
import { DockerLive } from "@/Docker/Docker.ts";
import { noopSession } from "@/Report.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import {
  apiTokenCredentials,
  Credentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const accountId = "0123456789abcdef0123456789abcdef";
const image = `registry.cloudflare.com/${accountId}/identity@sha256:${"a".repeat(64)}`;
const configuration = {
  image,
  instanceType: "lite" as const,
  environmentVariables: [
    { name: "ALCHEMY_CLOUDFLARE_ACCOUNT_ID", value: accountId },
  ],
};
const cached: ContainerApplication["Attributes"] = {
  accountId,
  applicationId: "application-id",
  applicationName: "owned-application",
  schedulingPolicy: "default",
  instances: 0,
  maxInstances: 20,
  constraints: {},
  affinities: undefined,
  configuration,
  durableObjects: undefined,
  createdAt: "2026-01-01T00:00:00Z",
  version: 1,
  dev: undefined,
};
const input = {
  id: "Application",
  fqn: "Application",
  instanceId: "0123456789abcdef0123456789abcdef",
  olds: { name: cached.applicationName, image },
  output: cached,
};
const environment = Layer.mergeAll(
  Layer.succeed(AlchemyContext, {
    dotAlchemy: ".alchemy-test",
    dev: false,
    adopt: false,
  }),
  Layer.succeed(
    CloudflareEnvironment,
    Effect.succeed({
      type: "apiToken",
      apiToken: Redacted.make("test-token"),
      accountId,
      source: { type: "env" },
    }),
  ),
  Layer.succeed(
    Credentials,
    Effect.succeed(apiTokenCredentials({ apiToken: "test-token" })),
  ),
  Layer.succeed(Stack, {
    name: "IdentityTest",
    stage: "test",
    resources: {},
    bindings: {},
    actions: {},
  }),
  Layer.sync(ArtifactStore, createArtifactStore),
  Layer.succeed(Stage, "test"),
  NodeServices.layer,
);
const docker = DockerLive.pipe(
  Layer.provide(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("Unexpected Docker command")),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const harness = (observed: ContainerApplication["Attributes"]) => {
  const methods: string[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      methods.push(request.method);
      expect(request.url).toMatch(
        /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+\/containers\/applications\/[^/]+$/,
      );
      expect(["GET", "PATCH"]).toContain(request.method);
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          success: true,
          errors: [],
          messages: [],
          result: {
            id: observed.applicationId,
            name: observed.applicationName,
            account_id: observed.accountId,
            scheduling_policy: observed.schedulingPolicy,
            instances: observed.instances,
            max_instances: observed.maxInstances,
            constraints: {},
            configuration: {
              image,
              instance_type: "lite",
              environment_variables: configuration.environmentVariables,
            },
            created_at: observed.createdAt,
            version: observed.version,
          },
        }),
      );
    }),
  );
  return {
    methods,
    layer: LiveContainerProvider().pipe(
      Layer.provide(docker),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http)),
      Layer.provideMerge(environment),
    ),
  };
};

describe("cached container identity", () => {
  // Regression: https://github.com/reve-ai/kommunikasie/commit/f2e7320ff261833092b84d8aa25e3563710661e8
  // A stale id must not replace the cached name during read or target a
  // different application during reconciliation.
  for (const operation of ["read", "reconcile"] as const) {
    for (const [field, value] of [
      ["applicationName", "foreign-application"],
      ["accountId", "fedcba9876543210fedcba9876543210"],
      ["applicationId", "foreign-application-id"],
    ] as const) {
      it.effect(
        `${operation} refuses a cached id with a different ${field}`,
        () => {
          const { methods, layer } = harness({ ...cached, [field]: value });
          return Effect.gen(function* () {
            const provider = yield* ContainerPlatform.Provider;
            const result = yield* (
              operation === "read"
                ? provider.read!(input)
                : provider.reconcile({
                    ...input,
                    news: input.olds,
                    bindings: [],
                    session: { ...noopSession, note: () => Effect.void },
                  })
            ).pipe(Effect.result);

            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure).toBeInstanceOf(Error);
              expect(result.failure.message).toContain("identity");
            }
            expect(methods).toEqual(["GET"]);
          }).pipe(Effect.provide(layer));
        },
      );
    }
  }

  it.effect("read preserves a matching cached identity", () => {
    const { methods, layer } = harness(cached);
    return Effect.gen(function* () {
      const provider = yield* ContainerPlatform.Provider;
      expect(yield* provider.read!(input)).toMatchObject({
        accountId,
        applicationId: cached.applicationId,
        applicationName: cached.applicationName,
      });
      expect(methods).toEqual(["GET"]);
    }).pipe(Effect.provide(layer));
  });

  for (const operation of ["read", "reconcile"] as const) {
    it.effect(
      `${operation} refuses cached attributes from another account`,
      () => {
        const output = {
          ...cached,
          accountId: "fedcba9876543210fedcba9876543210",
        };
        const { methods, layer } = harness(output);
        return Effect.gen(function* () {
          const provider = yield* ContainerPlatform.Provider;
          const result = yield* (
            operation === "read"
              ? provider.read!({ ...input, output })
              : provider.reconcile({
                  ...input,
                  output,
                  news: input.olds,
                  bindings: [],
                  session: { ...noopSession, note: () => Effect.void },
                })
          ).pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          expect(methods).toEqual([]);
        }).pipe(Effect.provide(layer));
      },
    );
  }
});
