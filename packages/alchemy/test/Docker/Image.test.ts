import { assert, describe, expect } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { dotAlchemyDirectory } from "@/AlchemyContext";
import * as Docker from "@/Docker";
import { findImageManifest, resolveImageManifest } from "@/Docker/ImageRegistry";
import { inMemoryState, State } from "@/State";
import * as Test from "@/Test/Alchemy";
import { authenticatedRegistry, findAvailablePort, scopedBuildx } from "./Runtime.ts";

const { test } = Test.make({ providers: Docker.providers(), state: inMemoryState() });

describe(
  "Docker.Image",
  { tags: ["provider:docker", "provider:docker:image", "local"], concurrent: false },
  () => {
    test.provider(
      "reuses published builds without a builder and retains shared manifests",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const client = yield* HttpClient.HttpClient;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-image-publication-" });
          yield* fs.writeFileString(
            path.join(root, "Dockerfile"),
            "FROM scratch\nCOPY payload /payload\n",
          );
          yield* fs.writeFileString(path.join(root, "payload"), "first");
          const port = yield* findAvailablePort();
          const registry = Docker.Container("Registry", {
            image: "registry:2",
            start: true,
            environment: { REGISTRY_STORAGE_DELETE_ENABLED: "true" },
            ports: [{ internal: 5000, external: port }],
          });
          yield* stack.deploy(registry);
          yield* client
            .get(`http://localhost:${port}/v2/`)
            .pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 8 }));
          const repository = `localhost:${port}/shared`;
          const build = { context: root, platform: "linux/amd64", options: ["--provenance=false"] };
          const deploy = (id: string, tags: string[] = []) =>
            stack.deploy(
              Effect.gen(function* () {
                yield* registry;
                return yield* Docker.Image(id, { build, publish: { repository, tags } });
              }),
            );
          const first = yield* deploy("First");
          expect(first.ref).toMatch(/@sha256:/);
          expect(first.imageId).toBeUndefined();
          expect(
            (yield* resolveImageManifest(`${repository}:${yield* Docker.buildCacheTag("First")}`))
              .ref,
          ).toBe(first.ref);
          const before = yield* Effect.sync(() => process.env.BUILDX_BUILDER);
          yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              process.env.BUILDX_BUILDER = "alchemy-intentionally-unavailable-builder";
            }),
            () =>
              Effect.gen(function* () {
                const second = yield* deploy("Second", ["release"]);
                expect(second.ref).toBe(first.ref);
                expect((yield* resolveImageManifest(`${repository}:release`)).ref).toBe(first.ref);
                yield* fs.writeFileString(path.join(root, "payload"), "changed");
                const plan = yield* stack.plan(
                  Effect.gen(function* () {
                    yield* registry;
                    return yield* Docker.Image("Second", {
                      build,
                      publish: { repository, tags: ["release"] },
                    });
                  }),
                );
                expect(plan.resources.Second).toMatchObject({ action: "update" });
              }),
            () =>
              Effect.sync(() => {
                if (before === undefined) delete process.env.BUILDX_BUILDER;
                else process.env.BUILDX_BUILDER = before;
              }),
          );
          const changed = yield* deploy("Second", ["release"]);
          expect(changed.ref).not.toBe(first.ref);
          const deleted = yield* client.del(
            `http://localhost:${port}/v2/shared/manifests/${changed.ref.split("@")[1]}`,
          );
          expect(deleted.status).toBe(202);
          expect(yield* findImageManifest(changed.ref)).toBeUndefined();
          const restored = yield* deploy("Second", ["release"]);
          expect(restored.ref).toBe(changed.ref);
          expect((yield* resolveImageManifest(`${repository}:release`)).ref).toBe(restored.ref);
          yield* stack.deploy(registry);
          expect((yield* resolveImageManifest(first.ref)).ref).toBe(first.ref);
          expect((yield* resolveImageManifest(changed.ref)).ref).toBe(changed.ref);
          yield* stack.destroy();
        }),
      { exclusive: true, timeout: 120_000 },
    );

    test.provider(
      "gives each image in a shared repository its own stable layer-cache tag",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const client = yield* HttpClient.HttpClient;
          const port = yield* findAvailablePort();
          const registry = Docker.Container("CacheRegistry", {
            image: "registry:2",
            start: true,
            ports: [{ internal: 5000, external: port }],
          });
          yield* stack.deploy(registry);
          yield* client
            .get(`http://localhost:${port}/v2/`)
            .pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 8 }));
          const repository = `localhost:${port}/shared-cache`;
          const program = (webVersion: string) =>
            Effect.gen(function* () {
              yield* registry;
              const image = (id: string, label: string) =>
                Docker.Image(id, {
                  build: {
                    dockerfile: { content: `FROM scratch\nLABEL image=${label}\n` },
                    platform: "linux/amd64",
                    options: ["--provenance=false"],
                  },
                  publish: { repository },
                });
              return { web: yield* image("Web", webVersion), api: yield* image("Api", "api") };
            });
          const cacheTags = client.get(`http://localhost:${port}/v2/shared-cache/tags/list`).pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.Struct({ tags: Schema.Array(Schema.String) })),
            ),
            Effect.map(({ tags }) => tags.filter((tag) => tag.startsWith("buildcache")).sort()),
          );
          const webTag = yield* Docker.buildCacheTag("Web");
          const apiTag = yield* Docker.buildCacheTag("Api");
          expect(webTag).not.toBe(apiTag);

          const first = yield* stack.deploy(program("first"));
          expect(yield* cacheTags).toEqual([webTag, apiTag].sort());
          expect((yield* resolveImageManifest(`${repository}:${webTag}`)).ref).toBe(first.web.ref);
          expect((yield* resolveImageManifest(`${repository}:${apiTag}`)).ref).toBe(first.api.ref);

          // A changed image moves only its own cache tag; the tag name is stable.
          const changed = yield* stack.deploy(program("second"));
          expect(changed.web.ref).not.toBe(first.web.ref);
          expect(yield* cacheTags).toEqual([webTag, apiTag].sort());
          expect((yield* resolveImageManifest(`${repository}:${webTag}`)).ref).toBe(
            changed.web.ref,
          );
          expect((yield* resolveImageManifest(`${repository}:${apiTag}`)).ref).toBe(first.api.ref);
          yield* stack.destroy();
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "hashes generated files, permissions, arguments, targets, platforms, and explicit invalidation",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const build = {
            dockerfile: {
              content:
                "FROM scratch AS first\nARG VALUE\nLABEL value=$VALUE\nCOPY payload /payload\nFROM first AS second\nLABEL target=second\n",
            },
            files: [{ path: "payload", content: "first", mode: 0o644 }],
            args: { VALUE: "first" },
            target: "first",
            platform: "linux/amd64",
          };
          const deploy = (overrides: Partial<Docker.DockerBuildOptions> = {}) =>
            stack.deploy(Docker.Image("Generated", { build: { ...build, ...overrides } }));
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const first = yield* deploy();
          const row = yield* (yield* yield* State).get({
            stack: stack.name,
            stage: stack.stage,
            fqn: "Generated",
          });
          assert(row?.status === "created" || row?.status === "updated");
          const contexts = path.resolve(
            yield* dotAlchemyDirectory,
            "docker",
            "contexts",
            row.instanceId,
          );
          const contextDirs = fs
            .readDirectory(contexts)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
          expect(yield* contextDirs).toHaveLength(1);
          const same = yield* deploy();
          expect(same.hash).toBe(first.hash);
          expect(same.ref).toBe(first.ref);
          for (const overrides of [
            { files: [{ path: "payload", content: "second", mode: 0o644 }] },
            { files: [{ path: "payload", content: "first", mode: 0o755 }] },
            { args: { VALUE: "second" } },
            { target: "second" },
            { platform: "linux/arm64" },
            { extraHash: "refresh-base" },
          ]) {
            const changed = yield* deploy(overrides);
            expect(changed.hash).not.toBe(first.hash);
            if (!("extraHash" in overrides)) expect(changed.ref).not.toBe(first.ref);
            // Only the current inputs' generated context survives an update.
            expect(yield* contextDirs).toHaveLength(1);
          }
          yield* stack.destroy();
          expect(yield* fs.exists(contexts)).toBe(false);
          const docker = yield* Docker.Docker;
          const remaining = yield* docker.run([
            "image",
            "ls",
            "--filter",
            `reference=${first.name}:*`,
            "--format",
            "{{.ID}}",
          ]);
          expect(remaining.stdout.trim()).toBe("");
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "publishes to an authenticated registry and distinguishes denied access from a missing image",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const port = yield* findAvailablePort();
          const server = `localhost:${port}`;
          const repository = `${server}/private`;
          const credentials = {
            username: "alchemy",
            password: Redacted.make("registry-test-password"),
          };
          const registry = Effect.gen(function* () {
            const image = yield* Docker.Image("RegistryImage", {
              build: {
                dockerfile: {
                  content:
                    "FROM registry:2\nCOPY htpasswd /auth/htpasswd\nENV REGISTRY_AUTH=htpasswd REGISTRY_AUTH_HTPASSWD_REALM=registry REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd\n",
                },
                files: [
                  {
                    path: "htpasswd",
                    content:
                      "alchemy:$2b$04$gM.RzckYdiAIldKldY8RZOng85a1PD80kaOcveOnoZfThZcrS0pOq\n",
                  },
                ],
              },
            });
            return yield* Docker.Container("Registry", {
              image: image.ref,
              start: true,
              ports: [{ internal: 5000, external: port }],
            });
          });
          yield* stack.deploy(registry);
          const client = yield* HttpClient.HttpClient;
          const response = yield* client
            .get(`http://${server}/v2/`)
            .pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 8 }));
          expect(response.status).toBe(401);
          const published = yield* stack.deploy(
            Effect.gen(function* () {
              yield* registry;
              return yield* Docker.Image("Private", {
                build: { dockerfile: { content: "FROM scratch\nLABEL private=true\n" } },
                publish: { repository, credentials, tags: ["release"] },
              });
            }),
          );
          expect(
            (yield* resolveImageManifest(`${repository}:release`, { server, ...credentials })).ref,
          ).toBe(published.ref);
          expect(
            yield* findImageManifest(`${repository}:missing`, { server, ...credentials }),
          ).toBeUndefined();
          const denied = yield* findImageManifest(published.ref, {
            server,
            username: "alchemy",
            password: Redacted.make("invalid-registry-secret"),
          }).pipe(Effect.result);
          assert(Result.isFailure(denied));
          expect(denied.failure.reason).toBe("AuthenticationFailed");
          expect(denied.failure.status).toBe(401);
          expect(JSON.stringify(denied.failure)).not.toContain("invalid-registry-secret");
          // A registry that cannot be reached is a request failure, not an
          // authentication failure, and keeps the transport error as its cause.
          const unreachable = yield* findImageManifest(
            `localhost:${yield* findAvailablePort()}/private:release`,
          ).pipe(Effect.result);
          assert(Result.isFailure(unreachable));
          expect(unreachable.failure.reason).toBe("RequestFailed");
          expect(unreachable.failure.cause).toMatchObject({ _tag: "HttpClientError" });
          yield* stack.destroy();
        }),
      { timeout: 120_000 },
    );

    test.provider("plans an update when the Docker context changes", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-context-plan-" });
        yield* fs.writeFileString(path.join(root, "Dockerfile"), "FROM scratch\n");

        const base = Docker.Image("context-image", {
          tag: "latest",
          context: "default",
          build: { context: root },
        });
        const changed = Docker.Image("context-image", {
          tag: "latest",
          context: "remote-build",
          build: { context: root },
        });

        yield* stack.deploy(base);
        const plan = yield* stack.plan(changed);
        expect(plan.resources["context-image"]).toMatchObject({ action: "update" });
      }),
    );

    test.provider("builds a tiny Dockerfile with an auto-generated name", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-image-" });
        yield* fs.writeFileString(
          path.join(root, "Dockerfile"),
          "FROM scratch\nLABEL alchemy.test=true\n",
        );
        // No explicit name: the engine auto-generates the physical name.
        const image = yield* stack.deploy(
          Docker.Image("tiny-image", { tag: "latest", build: { context: root } }),
        );
        expect(image.imageRef.endsWith(":latest")).toBe(true);
        expect(image.imageId).toMatch(/^sha256:/);
        expect(image.ref).toBe(image.imageId);
      }),
    );

    test.provider("updates when the build context changes", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-canary-" });
        yield* fs.writeFileString(path.join(root, "Dockerfile"), "FROM scratch\n");
        yield* fs.writeFileString(
          path.join(root, "Dockerfile"),
          "FROM scratch\nLABEL alchemy.test=1\n",
        );

        const makeStack = Docker.Image("tiny-image", { tag: "latest", build: { context: root } });

        yield* stack.deploy(makeStack);
        const plan1 = yield* stack.plan(makeStack);
        expect(plan1.resources["tiny-image"]).toMatchObject({ action: "noop" });
        yield* fs.writeFileString(
          path.join(root, "Dockerfile"),
          "FROM scratch\nLABEL alchemy.test=2\n",
        );
        const plan2 = yield* stack.plan(makeStack);
        expect(plan2.resources["tiny-image"]).toMatchObject({ action: "update" });
      }),
    );

    test.provider("builds with an explicit repository name and tag", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-image-named-" });
        yield* fs.writeFileString(
          path.join(root, "Dockerfile"),
          "FROM scratch\nLABEL alchemy.test=named\n",
        );
        const image = yield* stack.deploy(
          Docker.Image("named-image", {
            name: "alchemy-test-named",
            tag: "v1",
            build: { context: root },
          }),
        );
        expect(image.name).toBe("alchemy-test-named");
        expect(image.imageRef).toBe("alchemy-test-named:v1");
        expect(image.tag).toBe("v1");
      }),
    );

    test.provider("rebuilds when the build context changes", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-image-rebuild-" });
        const dockerfile = path.join(root, "Dockerfile");

        yield* fs.writeFileString(dockerfile, "FROM scratch\nLABEL gen=1\n");
        const first = yield* stack.deploy(
          Docker.Image("rebuilt-image", { tag: "latest", build: { context: root } }),
        );

        yield* fs.writeFileString(dockerfile, "FROM scratch\nLABEL gen=2\n");
        const second = yield* stack.deploy(
          Docker.Image("rebuilt-image", { tag: "latest", build: { context: root } }),
        );

        expect(second.imageRef).toBe(first.imageRef);
      }),
    );

    // A build failing inside a `RUN` step must say why, not just its exit
    // code: the step's own output has to reach the deploy error. BuildKit
    // logs steps to stderr; the legacy builder (no Buildx plugin, or
    // `DOCKER_BUILDKIT=0`) logs them to stdout and only the exit reason to
    // stderr.
    for (const [builder, buildkit] of [
      ["BuildKit", undefined],
      ["the legacy builder", "0"],
    ] as const) {
      test.provider(
        `reports the failing RUN step's output when a build fails with ${builder}`,
        (stack) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({
              prefix: "alchemy-docker-image-fail-",
            });
            yield* fs.writeFileString(
              path.join(root, "Dockerfile"),
              // Computed in the step so only the step's output, never the echoed
              // command, contains the expected text.
              'FROM alpine:3.19\nRUN echo "npm ERR! missing script: build-$((40 + 2))" && exit 3\n',
            );
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                const previous = process.env.DOCKER_BUILDKIT;
                if (buildkit === undefined) delete process.env.DOCKER_BUILDKIT;
                else process.env.DOCKER_BUILDKIT = buildkit;
                return previous;
              }),
              (previous) =>
                Effect.sync(() => {
                  if (previous === undefined) delete process.env.DOCKER_BUILDKIT;
                  else process.env.DOCKER_BUILDKIT = previous;
                }),
            );

            const error = yield* stack
              .deploy(Docker.Image("failing-image", { tag: "latest", build: { context: root } }))
              .pipe(Effect.flip);

            const report = yield* Effect.sync(() => String(error) + JSON.stringify(error));
            expect(report).toContain("npm ERR! missing script: build-42");
          }),
        // Mutates `process.env.DOCKER_BUILDKIT`.
        { exclusive: true },
      );
    }

    test.provider("builds FROM a private base image with the registry credentials", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Anonymous pulls get 401, and nothing on the host holds a
        // `docker login` for this ephemeral port.
        const { host, credentials: registry } = yield* authenticatedRegistry();
        const baseRef = `${host}/alchemy-base:v1`;
        yield* Effect.addFinalizer(() =>
          docker.image.remove([baseRef, `${host}/alchemy-app:v1`], true).pipe(Effect.ignore),
        );

        // Publish the private base image, then drop the local copy so the
        // build below has to pull it from the authenticated registry.
        yield* stack.deploy(
          Docker.RemoteImage("private-base", {
            name: "busybox",
            tag: "latest",
            targetName: `${host}/alchemy-base`,
            targetTag: "v1",
            registry,
          }),
        );
        yield* docker.image.remove(baseRef, true);

        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-private-base-" });
        yield* fs.writeFileString(
          path.join(root, "Dockerfile"),
          `FROM ${baseRef}\nLABEL alchemy.test=private-base\n`,
        );

        const image = yield* stack.deploy(
          Docker.Image("private-base-app", {
            name: `${host}/alchemy-app`,
            tag: "v1",
            registry,
            build: { context: root },
          }),
        );
        expect(image.imageRef).toBe(`${host}/alchemy-app:v1`);
        expect(image.repoDigest).toContain(`${host}/alchemy-app@sha256:`);
      }),
    );

    // Publish `busybox` as a private base image, then drop the local copy so
    // a build has to pull it back through the registry's auth.
    const publishPrivateBase = (
      host: string,
      credentials: Docker.RegistryCredentials,
      repository: string,
    ) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const ref = `${host}/${repository}:v1`;
        yield* docker.image.pull("busybox:latest");
        yield* docker.image.tag("busybox:latest", ref);
        yield* docker.image.push(ref, credentials);
        yield* docker.image.remove(ref, true);
        yield* Effect.addFinalizer(() => docker.image.remove(ref, true).pipe(Effect.ignore));
        return ref;
      });

    const dockerfileContext = (dockerfile: string) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-build-auth-" });
        yield* fs.writeFileString(path.join(root, "Dockerfile"), dockerfile);
        return root;
      });

    test.provider("authenticates the build but does not push when skipPush is set", (stack) =>
      Effect.gen(function* () {
        const registry = yield* authenticatedRegistry();
        const baseRef = yield* publishPrivateBase(registry.host, registry.credentials, "skip-base");
        const root = yield* dockerfileContext(`FROM ${baseRef}\nLABEL alchemy.test=skip-push\n`);

        yield* stack.deploy(
          Docker.Image("skip-push-app", {
            name: `${registry.host}/skip-push-app`,
            tag: "v1",
            registry: registry.credentials,
            skipPush: true,
            build: { context: root },
          }),
        );
        expect(yield* registry.hasManifest("skip-push-app", "v1")).toBe(false);
      }),
    );

    test.provider("fails the build with 401 when the registry credentials are wrong", (stack) =>
      Effect.gen(function* () {
        const registry = yield* authenticatedRegistry();
        const baseRef = yield* publishPrivateBase(
          registry.host,
          registry.credentials,
          "wrong-base",
        );
        const root = yield* dockerfileContext(`FROM ${baseRef}\n`);

        const error = yield* stack
          .deploy(
            Docker.Image("wrong-credentials-app", {
              name: `${registry.host}/wrong-credentials-app`,
              tag: "v1",
              registry: { ...registry.credentials, password: Redacted.make("not-the-password") },
              build: { context: root },
            }),
          )
          .pipe(Effect.flip);
        const report = yield* Effect.sync(() => String(error) + JSON.stringify(error));
        expect(report).toMatch(/401|unauthorized/i);
        expect(report).not.toContain("not-the-password");
        expect(yield* registry.hasManifest("wrong-credentials-app", "v1")).toBe(false);
      }),
    );

    test.provider("keeps existing DOCKER_AUTH_CONFIG credentials for other registries", (stack) =>
      Effect.gen(function* () {
        // Base A lives behind credentials the user already has in
        // DOCKER_AUTH_CONFIG; base B behind the Image's own `registry`.
        const a = yield* authenticatedRegistry();
        const b = yield* authenticatedRegistry();
        const baseA = yield* publishPrivateBase(a.host, a.credentials, "base-a");
        const baseB = yield* publishPrivateBase(b.host, b.credentials, "base-b");
        const auth = yield* Effect.sync(() =>
          Buffer.from("alchemy:alchemy-test-password").toString("base64"),
        );
        const root = yield* dockerfileContext(
          `FROM ${baseA} AS a\nFROM ${baseB}\nCOPY --from=a /bin/busybox /from-a\n`,
        );

        // As if exported before starting Alchemy.
        const image = yield* stack
          .deploy(
            Docker.Image("two-registries-app", {
              name: `${b.host}/two-registries-app`,
              tag: "v1",
              registry: b.credentials,
              build: { context: root },
            }),
          )
          .pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  DOCKER_AUTH_CONFIG: JSON.stringify({ auths: { [a.host]: { auth } } }),
                }),
              ),
            ),
          );
        expect(image.repoDigest).toContain(`${b.host}/two-registries-app@sha256:`);
      }),
    );

    test.provider("never writes the registry password to state", (stack) =>
      Effect.gen(function* () {
        const registry = yield* authenticatedRegistry();
        const baseRef = yield* publishPrivateBase(
          registry.host,
          registry.credentials,
          "state-base",
        );
        const root = yield* dockerfileContext(`FROM ${baseRef}\n`);
        yield* stack.deploy(
          Docker.Image("state-app", {
            name: `${registry.host}/state-app`,
            tag: "v1",
            registry: registry.credentials,
            build: { context: root },
          }),
        );
        const state = yield* yield* State;
        const fqns = yield* state.list({ stack: stack.name, stage: stack.stage });
        const rows = yield* Effect.forEach(fqns, (fqn) =>
          state.get({ stack: stack.name, stage: stack.stage, fqn }),
        );
        const persisted = yield* Effect.sync(() => JSON.stringify(rows));
        expect(persisted).not.toContain("alchemy-test-password");
      }),
    );

    // The legacy builder (no Buildx plugin) also honors DOCKER_AUTH_CONFIG.
    // Buildx < 0.26 does not; that limit is documented on `registry`.
    for (const [builder, version] of [["without a Buildx plugin", undefined]] as const) {
      test.provider(
        `builds FROM a private base image ${builder}`,
        (stack) =>
          Effect.gen(function* () {
            const registry = yield* authenticatedRegistry();
            const baseRef = yield* publishPrivateBase(
              registry.host,
              registry.credentials,
              `builder-base-${version ?? "legacy"}`,
            );
            yield* scopedBuildx(version);
            const root = yield* dockerfileContext(`FROM ${baseRef}\n`);
            const image = yield* stack.deploy(
              Docker.Image(`builder-app-${version ?? "legacy"}`, {
                name: `${registry.host}/builder-app`,
                tag: version ?? "legacy",
                registry: registry.credentials,
                build: { context: root },
              }),
            );
            expect(image.repoDigest).toContain(`${registry.host}/builder-app@sha256:`);
          }),
        // Mutates `process.env.DOCKER_CONFIG` / `DOCKER_HOST`.
        { exclusive: true, timeout: 180_000 },
      );
    }
  },
);
