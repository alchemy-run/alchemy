import { AlchemyContext } from "@/AlchemyContext.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
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
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const accountId = "0123456789abcdef0123456789abcdef";
const digest = `sha256:${"a".repeat(64)}`;
const indexType = "application/vnd.oci.image.index.v1+json";

const exportImage = Effect.fn("exportImage")(function* (options: {
  indexOnly?: boolean;
  failFirstBuild?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* fs.makeTempDirectoryScoped({
    prefix: "alchemy-export-test-",
  });
  yield* fs.writeFileString(path.join(context, "Dockerfile"), "FROM scratch\n");
  const commands: ChildProcess.StandardCommand[] = [];
  let builds = 0;
  let acceptedTypes: string | undefined;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (command._tag !== "StandardCommand")
        throw new Error("Unexpected pipeline");
      commands.push(command);
      const isBuild = command.args.includes("build");
      if (isBuild) builds++;
      const failed = options.failFirstBuild && isBuild && builds === 1;
      const stdout = Stream.succeed(
        new TextEncoder().encode(
          command.args.includes("version")
            ? "github.com/docker/buildx v0.26.0 abc123"
            : "published",
        ),
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(failed ? 1 : 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout,
        stderr: failed
          ? Stream.succeed(
              new TextEncoder().encode(
                "unexpected status: 500 Internal Server Error",
              ),
            )
          : Stream.empty,
        all: stdout,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.method === "HEAD") {
        expect(request.url).toMatch(
          /^https:\/\/registry\.cloudflare\.com\/v2\//,
        );
        acceptedTypes = request.headers.accept;
        const status =
          options.indexOnly && !acceptedTypes?.includes(indexType) ? 406 : 200;
        return HttpClientResponse.fromWeb(
          request,
          new Response(null, {
            status,
            headers: {
              "docker-content-digest": digest,
              "content-type": indexType,
            },
          }),
        );
      }
      let result: unknown;
      if (request.url.endsWith("/credentials")) {
        expect(request.method).toBe("POST");
        result = { username: "publisher", password: "test-token" };
      } else if (request.url.endsWith("/containers/applications")) {
        if (request.method === "GET") {
          result = [];
        } else {
          expect(request.method).toBe("POST");
          if (request.body._tag !== "Uint8Array")
            throw new Error("Expected JSON request");
          const body = Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
          )(new TextDecoder().decode(request.body.body));
          result = {
            ...body,
            id: "application-id",
            account_id: accountId,
            created_at: "2026-01-01T00:00:00Z",
            version: 1,
          };
        }
      } else {
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ success: true, errors: [], messages: [], result }),
      );
    }),
  );
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
      name: "RegistryExportTest",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    }),
    Layer.succeed(Stage, "test"),
    Layer.succeed(HttpClient.HttpClient, http),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({ DOCKER_BIN: "docker-test" }),
    ),
    DockerLive.pipe(
      Layer.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    ),
  ).pipe(Layer.provide(NodeServices.layer));
  const output = yield* Effect.gen(function* () {
    const provider = yield* ContainerPlatform.Provider;
    return yield* provider.reconcile({
      id: "Export",
      fqn: "Export",
      instanceId: "0123456789abcdef0123456789abcdef",
      news: { name: "registry-export", context },
      olds: undefined,
      output: undefined,
      bindings: [],
      session: { ...noopSession, note: () => Effect.void },
    });
  }).pipe(Effect.provide(LiveContainerProvider()), Effect.provide(environment));
  return { output, commands, builds, acceptedTypes };
});

describe("Container registry export", () => {
  it.effect("exports Dockerfiles directly and resolves OCI image indexes", () =>
    Effect.gen(function* () {
      const { output, commands, acceptedTypes } = yield* exportImage({
        indexOnly: true,
      });
      expect(
        commands.filter((command) => command.args.includes("--push")),
      ).toHaveLength(1);
      expect(commands.some((command) => command.args.includes("push"))).toBe(
        false,
      );
      expect(acceptedTypes).toContain(indexType);
      expect(acceptedTypes).toContain(
        "application/vnd.docker.distribution.manifest.list.v2+json",
      );
      expect(output.configuration.image).toBe(
        `registry.cloudflare.com/${accountId}/registry-export@${digest}`,
      );
      expect(output.hash?.digest).toBe(digest);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("retries transient BuildKit registry export failures", () =>
    Effect.gen(function* () {
      const { builds, commands } = yield* exportImage({ failFirstBuild: true });
      expect(builds).toBe(2);
      expect(
        commands.filter((command) => command.args.includes("--push")),
      ).toHaveLength(2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
