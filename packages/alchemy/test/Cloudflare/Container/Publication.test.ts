import { AlchemyContext } from "@/AlchemyContext.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import type {
  AnyContainerApplicationProps,
  ContainerApplication,
} from "@/Cloudflare/Containers/ContainerApplication.ts";
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
const otherDigest = `sha256:${"b".repeat(64)}`;
const account = (id: string) =>
  Effect.succeed({
    type: "apiToken" as const,
    apiToken: Redacted.make("test-token"),
    accountId: id,
    source: { type: "env" as const },
  });

const harness = Effect.fn("publicationHarness")(function* (
  options: {
    failFirstBuild?: boolean;
    blockFirstBuild?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* fs.makeTempDirectoryScoped({
    prefix: "alchemy-publication-test-",
  });
  yield* fs.writeFileString(path.join(context, "Dockerfile"), "FROM scratch\n");
  const buildStarted = yield* Deferred.make<void>();
  const releaseBuild = yield* Deferred.make<void>();
  const secondObserved = yield* Deferred.make<void>();
  const commands: ChildProcess.StandardCommand[] = [];
  const heads: string[] = [];
  const applications = new Map<string, Record<string, unknown>>();
  let builds = 0;
  let observations = 0;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand")
        return yield* Effect.die("Unexpected pipeline");
      commands.push(command);
      const isBuild = command.args.includes("build");
      if (isBuild) builds++;
      const firstBuild = isBuild && builds === 1;
      if (firstBuild && options.blockFirstBuild) {
        yield* Deferred.succeed(buildStarted, undefined);
        yield* Deferred.await(releaseBuild);
      }
      const failed = firstBuild && options.failFirstBuild;
      const stdout = Stream.succeed(new TextEncoder().encode("published"));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(failed ? 1 : 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout,
        stderr: failed
          ? Stream.succeed(new TextEncoder().encode("build failed"))
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
        heads.push(request.url);
        return HttpClientResponse.fromWeb(
          request,
          new Response(null, {
            headers: {
              "docker-content-digest": request.url.endsWith("/old-two")
                ? otherDigest
                : digest,
            },
          }),
        );
      }
      let result: unknown;
      if (request.url.endsWith("/credentials")) {
        result = { username: "publisher", password: "test-token" };
      } else {
        const route = request.url.match(
          /\/accounts\/([^/]+)\/containers\/applications(?:\/([^/]+))?(\/rollouts)?$/,
        );
        if (!route)
          throw new Error(
            `Unexpected request: ${request.method} ${request.url}`,
          );
        const [, requestAccount, applicationId, rollout] = route;
        if (request.method === "GET") {
          if (applicationId === undefined) observations++;
          result =
            applicationId === undefined ? [] : applications.get(applicationId);
        } else {
          if (request.body._tag !== "Uint8Array")
            throw new Error("Expected JSON body");
          const body = Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
          )(new TextDecoder().decode(request.body.body));
          const id = applicationId ?? `app-${body.name}`;
          const stored = applications.get(id);
          if (rollout) {
            result = stored;
          } else {
            const application = {
              ...stored,
              ...body,
              id,
              account_id: requestAccount,
              created_at: "2026-01-01T00:00:00Z",
              version: 1,
            };
            applications.set(id, application);
            result = application;
          }
        }
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ success: true, errors: [], messages: [], result }),
      );
    }).pipe(
      Effect.tap(() =>
        observations === 2
          ? Deferred.succeed(secondObserved, undefined)
          : Effect.void,
      ),
    ),
  );
  const environment = Layer.mergeAll(
    Layer.succeed(AlchemyContext, {
      dotAlchemy: ".alchemy-test",
      dev: false,
      adopt: false,
    }),
    Layer.succeed(CloudflareEnvironment, account(accountId)),
    Layer.succeed(
      Credentials,
      Effect.succeed(apiTokenCredentials({ apiToken: "test-token" })),
    ),
    Layer.succeed(Stack, {
      name: "PublicationTest",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    }),
    Layer.succeed(Stage, "test"),
    Layer.succeed(HttpClient.HttpClient, http),
    DockerLive.pipe(
      Layer.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    ),
  ).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ DOCKER_BIN: "docker-test" }),
      ),
    ),
  );
  const layer = LiveContainerProvider().pipe(Layer.provideMerge(environment));
  const reconcile = Effect.fn("reconcileTestApplication")(function* (
    name: string,
    props: AnyContainerApplicationProps = {},
    output?: ContainerApplication["Attributes"],
  ) {
    const provider = yield* ContainerPlatform.Provider;
    return yield* provider.reconcile({
      id: name,
      fqn: name,
      instanceId: "0123456789abcdef0123456789abcdef",
      news: { context, ...props, name },
      olds: undefined,
      output,
      bindings: [],
      session: { ...noopSession, note: () => Effect.void },
    });
  });
  return {
    layer,
    reconcile,
    commands,
    heads,
    applications,
    context,
    buildStarted,
    releaseBuild,
    secondObserved,
  };
});

const count = (commands: ChildProcess.StandardCommand[], operation: string) =>
  commands.filter((command) => command.args.includes(operation)).length;

describe("Container image publication", () => {
  it.effect(
    "shares concurrent and completed publication without sharing application environments",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ blockFirstBuild: true });
        yield* Effect.gen(function* () {
          const first = yield* h
            .reconcile("one", { env: { APP: "one" } })
            .pipe(Effect.forkChild);
          yield* Deferred.await(h.buildStarted);
          const second = yield* h
            .reconcile("two", { env: { APP: "two" } })
            .pipe(Effect.forkChild);
          yield* Deferred.await(h.secondObserved);
          yield* Effect.yieldNow;
          expect(count(h.commands, "build")).toBe(1);
          yield* Deferred.succeed(h.releaseBuild, undefined);
          const [one, two] = yield* Effect.all([
            Fiber.join(first),
            Fiber.join(second),
          ]);
          const three = yield* h.reconcile("three", { env: { APP: "three" } });

          expect(count(h.commands, "build")).toBe(1);
          expect(count(h.commands, "push")).toBe(1);
          expect(h.heads).toHaveLength(1);
          expect(one.configuration.image).toBe(two.configuration.image);
          expect(three.configuration.image).toBe(one.configuration.image);
          for (const [name, output] of [
            ["one", one],
            ["two", two],
            ["three", three],
          ] as const) {
            expect(output.applicationName).toBe(name);
            expect(output.configuration.environmentVariables).toContainEqual({
              name: "APP",
              value: name,
            });
          }
        }).pipe(Effect.provide(h.layer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "evicts a failed publication so a later attempt can succeed and be reused",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ failFirstBuild: true });
        yield* Effect.gen(function* () {
          yield* h.reconcile("failed").pipe(Effect.flip);
          const retry = yield* h.reconcile("retry");
          const shared = yield* h.reconcile("shared");
          expect(count(h.commands, "build")).toBe(2);
          expect(count(h.commands, "push")).toBe(1);
          expect(shared.configuration.image).toBe(retry.configuration.image);
        }).pipe(Effect.provide(h.layer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "evicts an interrupted publication so the next application can publish",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ blockFirstBuild: true });
        yield* Effect.gen(function* () {
          const interrupted = yield* h
            .reconcile("interrupted")
            .pipe(Effect.forkChild);
          yield* Deferred.await(h.buildStarted);
          yield* Fiber.interrupt(interrupted);
          const retry = yield* h.reconcile("retry");
          const shared = yield* h.reconcile("shared");
          expect(count(h.commands, "build")).toBe(2);
          expect(count(h.commands, "push")).toBe(1);
          expect(shared.configuration.image).toBe(retry.configuration.image);
        }).pipe(Effect.provide(h.layer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("separates accounts, registries, and image content", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.gen(function* () {
        yield* h.reconcile("original");
        const otherAccount = yield* h
          .reconcile("account")
          .pipe(
            Effect.provideService(
              CloudflareEnvironment,
              account("fedcba9876543210fedcba9876543210"),
            ),
          );
        const otherRegistry = yield* h.reconcile("registry", {
          registryId: "registry.example.test",
        });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(
          path.join(h.context, "Dockerfile"),
          "FROM scratch\nENV CHANGED=true\n",
        );
        yield* h.reconcile("content");
        expect(count(h.commands, "build")).toBe(4);
        expect(count(h.commands, "push")).toBe(4);
        expect(otherAccount.configuration.image).toContain(
          "fedcba9876543210fedcba9876543210",
        );
        expect(otherRegistry.configuration.image).toContain(
          "registry.example.test/",
        );
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("starts a new publication cache for a fresh provider", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.reconcile("first").pipe(Effect.provide(Layer.fresh(h.layer)));
      yield* h.reconcile("second").pipe(Effect.provide(Layer.fresh(h.layer)));
      expect(count(h.commands, "build")).toBe(2);
      expect(count(h.commands, "push")).toBe(2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("compares each application's previous digest independently", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.gen(function* () {
        const one = yield* h.reconcile("one");
        const two = yield* h.reconcile("two");
        const oldOne = `registry.cloudflare.com/${accountId}/one:old-one`;
        const oldTwo = `registry.cloudflare.com/${accountId}/two:old-two`;
        for (const [output, image] of [
          [one, oldOne],
          [two, oldTwo],
        ] as const) {
          const stored = h.applications.get(output.applicationId);
          h.applications.set(output.applicationId, {
            ...stored,
            configuration: { image },
          });
        }
        const [updatedOne, updatedTwo] = yield* Effect.all(
          [
            h.reconcile("one", {}, { ...one, hash: undefined }),
            h.reconcile("two", {}, { ...two, hash: undefined }),
          ],
          { concurrency: "unbounded" },
        );
        expect(updatedOne.configuration.image).toBe(oldOne);
        expect(updatedTwo.configuration.image).toBe(one.configuration.image);
        expect(h.heads.filter((url) => url.endsWith("/old-one"))).toHaveLength(
          1,
        );
        expect(h.heads.filter((url) => url.endsWith("/old-two"))).toHaveLength(
          1,
        );
        expect(count(h.commands, "push")).toBe(1);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
