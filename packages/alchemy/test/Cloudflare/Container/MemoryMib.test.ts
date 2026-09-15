import { AlchemyContext } from "@/AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "@/Artifacts.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import { ContainerPlatform } from "@/Cloudflare/Containers/ContainerPlatform.ts";
import { LiveContainerProvider } from "@/Cloudflare/Containers/ContainerProvider.ts";
import { LocalContainerProvider } from "@/Cloudflare/Containers/LocalContainerProvider.ts";
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
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const accountId = "0123456789abcdef0123456789abcdef";
const image = `registry.cloudflare.com/${accountId}/memory-test@sha256:${"a".repeat(64)}`;
const session = { ...noopSession, note: () => Effect.void };
const baseInput = {
  id: "Memory",
  fqn: "Memory",
  instanceId: "0123456789abcdef0123456789abcdef",
  olds: undefined,
  output: undefined,
  bindings: [],
  session,
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
    name: "MemoryTest",
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

describe("Container memoryMib", () => {
  it.effect(
    "forwards memoryMib to the API without selecting the default instance type",
    () => {
      const configurations: unknown[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          expect(request.url).toBe(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/containers/applications`,
          );
          let result: unknown;
          if (request.method === "GET") {
            result = [];
          } else {
            expect(request.method).toBe("POST");
            if (request.body._tag !== "Uint8Array") {
              throw new Error("Expected a JSON application request");
            }
            const body = Schema.decodeUnknownSync(
              Schema.fromJsonString(
                Schema.Record(Schema.String, Schema.Unknown),
              ),
            )(new TextDecoder().decode(request.body.body));
            configurations.push(body.configuration);
            result = {
              ...body,
              id: "application-id",
              account_id: accountId,
              created_at: "2026-01-01T00:00:00Z",
              version: 1,
            };
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ success: true, errors: [], messages: [], result }),
          );
        }),
      );

      return Effect.gen(function* () {
        const provider = yield* ContainerPlatform.Provider;
        const output = yield* provider.reconcile({
          ...baseInput,
          news: { name: "memory-test", image, memoryMib: 6144 },
        });

        expect(configurations).toHaveLength(1);
        expect(configurations[0]).toMatchObject({ image, memory_mib: 6144 });
        expect(configurations[0]).not.toHaveProperty("instance_type");
        expect(output.configuration.memoryMib).toBe(6144);
      }).pipe(
        Effect.provide(LiveContainerProvider()),
        Effect.provide(docker),
        Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Effect.provide(environment),
      );
    },
  );

  it.effect("preserves memoryMib in local application attributes", () =>
    Effect.gen(function* () {
      const provider = yield* ContainerPlatform.Provider;
      const output = yield* provider.reconcile({
        ...baseInput,
        news: { name: "memory-test", image, memoryMib: 6144 },
      });

      expect(output.configuration.memoryMib).toBe(6144);
    }).pipe(
      Effect.provide(LocalContainerProvider()),
      Effect.provide(docker),
      Effect.provide(environment),
    ),
  );
});
