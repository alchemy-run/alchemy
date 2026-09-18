import * as Docker from "@/Docker";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { assert, describe, expect } from "alchemy-test";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  findImageManifest,
  resolveImageManifest,
} from "@/Docker/ImageRegistry";
import { findAvailablePort } from "./Runtime.ts";

const { test } = Test.make({
  providers: Docker.providers(),
  state: inMemoryState(),
});

describe("Docker.Image", { concurrent: false }, () => {
  test.provider(
    "reuses published builds without a builder and retains shared manifests",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const client = yield* HttpClient.HttpClient;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "alchemy-image-publication-",
        });
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
          .pipe(
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 8 }),
          );
        const repository = `localhost:${port}/shared`;
        const build = {
          context: root,
          platform: "linux/amd64",
          options: ["--provenance=false"],
        };
        const deploy = (id: string, tags: string[] = []) =>
          stack.deploy(
            Effect.gen(function* () {
              yield* registry;
              return yield* Docker.Image(id, {
                build,
                publish: { repository, tags },
              });
            }),
          );
        const first = yield* deploy("First");
        expect(first.ref).toMatch(/@sha256:/);
        expect(first.imageId).toBeUndefined();
        expect(
          (yield* resolveImageManifest(`${repository}:buildcache`)).ref,
        ).toBe(first.ref);
        const before = yield* Effect.sync(() => process.env.BUILDX_BUILDER);
        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            process.env.BUILDX_BUILDER =
              "alchemy-intentionally-unavailable-builder";
          }),
          () =>
            Effect.gen(function* () {
              const second = yield* deploy("Second", ["release"]);
              expect(second.ref).toBe(first.ref);
              expect(
                (yield* resolveImageManifest(`${repository}:release`)).ref,
              ).toBe(first.ref);
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
        expect((yield* resolveImageManifest(`${repository}:release`)).ref).toBe(
          restored.ref,
        );
        yield* stack.deploy(registry);
        expect((yield* resolveImageManifest(first.ref)).ref).toBe(first.ref);
        expect((yield* resolveImageManifest(changed.ref)).ref).toBe(
          changed.ref,
        );
        yield* stack.destroy();
      }),
    { exclusive: true, timeout: 120_000 },
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
          stack.deploy(
            Docker.Image("Generated", { build: { ...build, ...overrides } }),
          );
        const first = yield* deploy();
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
          if (!("extraHash" in overrides))
            expect(changed.ref).not.toBe(first.ref);
        }
        yield* stack.destroy();
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
          .pipe(
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 8 }),
          );
        expect(response.status).toBe(401);
        const published = yield* stack.deploy(
          Effect.gen(function* () {
            yield* registry;
            return yield* Docker.Image("Private", {
              build: {
                dockerfile: { content: "FROM scratch\nLABEL private=true\n" },
              },
              publish: { repository, credentials, tags: ["release"] },
            });
          }),
        );
        expect(
          (yield* resolveImageManifest(`${repository}:release`, {
            server,
            ...credentials,
          })).ref,
        ).toBe(published.ref);
        expect(
          yield* findImageManifest(`${repository}:missing`, {
            server,
            ...credentials,
          }),
        ).toBeUndefined();
        const denied = yield* findImageManifest(published.ref, {
          server,
          username: "alchemy",
          password: Redacted.make("invalid-registry-secret"),
        }).pipe(Effect.result);
        assert(Result.isFailure(denied));
        expect(denied.failure.reason).toBe("AuthenticationFailed");
        expect(denied.failure.status).toBe(401);
        expect(JSON.stringify(denied.failure)).not.toContain(
          "invalid-registry-secret",
        );
        yield* stack.destroy();
      }),
    { timeout: 120_000 },
  );

  test.provider("plans an update when the Docker context changes", (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-docker-context-plan-",
      });
      yield* fs.writeFileString(
        path.join(root, "Dockerfile"),
        "FROM scratch\n",
      );

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
      expect(plan.resources["context-image"]).toMatchObject({
        action: "update",
      });
    }),
  );

  test.provider(
    "builds a tiny Dockerfile with an auto-generated name",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "alchemy-docker-image-",
        });
        yield* fs.writeFileString(
          path.join(root, "Dockerfile"),
          "FROM scratch\nLABEL alchemy.test=true\n",
        );
        // No explicit name: the engine auto-generates the physical name.
        const image = yield* stack.deploy(
          Docker.Image("tiny-image", {
            tag: "latest",
            build: { context: root },
          }),
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
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-docker-canary-",
      });
      yield* fs.writeFileString(
        path.join(root, "Dockerfile"),
        "FROM scratch\n",
      );
      yield* fs.writeFileString(
        path.join(root, "Dockerfile"),
        "FROM scratch\nLABEL alchemy.test=1\n",
      );

      const makeStack = Docker.Image("tiny-image", {
        tag: "latest",
        build: { context: root },
      });

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
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-docker-image-named-",
      });
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
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-docker-image-rebuild-",
      });
      const dockerfile = path.join(root, "Dockerfile");

      yield* fs.writeFileString(dockerfile, "FROM scratch\nLABEL gen=1\n");
      const first = yield* stack.deploy(
        Docker.Image("rebuilt-image", {
          tag: "latest",
          build: { context: root },
        }),
      );

      yield* fs.writeFileString(dockerfile, "FROM scratch\nLABEL gen=2\n");
      const second = yield* stack.deploy(
        Docker.Image("rebuilt-image", {
          tag: "latest",
          build: { context: root },
        }),
      );

      expect(second.imageRef).toBe(first.imageRef);
    }),
  );
});
