import * as Docker from "@/Docker";
import * as Provider from "@/Provider";
import * as Output from "@/Output";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { findAvailablePort } from "./Runtime.ts";
import { resolveImageManifest, syncImageTags } from "@/Docker/ImageRegistry";

const { test } = Test.make({
  providers: Docker.providers(),
  state: inMemoryState(),
});

test.provider("diff pulls again unless alwaysPull is disabled", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Docker.RemoteImage);
    const output = {
      ref: "sha256:0",
      imageRef: "nginx:alpine",
      imageId: "sha256:0",
      createdAt: 0,
      name: "nginx",
      tag: "alpine",
    };

    const pinned = yield* provider.diff!({
      id: "nginx",
      fqn: "nginx",
      instanceId: "instance",
      olds: { name: "nginx", tag: "alpine", alwaysPull: false },
      news: { name: "nginx", tag: "alpine", alwaysPull: false },
      oldBindings: [],
      newBindings: [],
      output,
    });
    expect(pinned).toBeUndefined();

    const refreshed = yield* provider.diff!({
      id: "nginx",
      fqn: "nginx",
      instanceId: "instance",
      olds: { name: "nginx", tag: "alpine", alwaysPull: false },
      news: { name: "nginx", tag: "alpine" },
      oldBindings: [],
      newBindings: [],
      output,
    });
    expect(refreshed).toEqual({ action: "update" });
  }),
);

test.provider("diff pulls again when Docker context changes", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Docker.RemoteImage);
    const output = {
      ref: "sha256:0",
      imageRef: "nginx:alpine",
      imageId: "sha256:0",
      createdAt: 0,
      name: "nginx",
      tag: "alpine",
    };

    const changed = yield* provider.diff!({
      id: "nginx",
      fqn: "nginx",
      instanceId: "instance",
      olds: {
        name: "nginx",
        tag: "alpine",
        alwaysPull: false,
        context: "default",
      },
      news: {
        name: "nginx",
        tag: "alpine",
        alwaysPull: false,
        context: "remote-build",
      },
      oldBindings: [],
      newBindings: [],
      output,
    });
    expect(changed).toEqual({ action: "update" });
  }),
);

describe("Docker.RemoteImage", { concurrent: false }, () => {
  test.provider(
    "observes mutable source drift, mirrors immutable references, and retains publications",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const port = yield* findAvailablePort();
        const client = yield* HttpClient.HttpClient;
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
        const repository = `localhost:${port}/source`;
        const destination = `localhost:${port}/mirror`;
        const producers = Effect.gen(function* () {
          yield* registry;
          const first = yield* Docker.Image("First", {
            build: {
              dockerfile: { content: "FROM scratch\nLABEL version=first\n" },
              platform: "linux/amd64",
              options: ["--provenance=false"],
            },
            publish: { repository, tags: ["current"] },
          });
          const second = yield* Docker.Image("Second", {
            build: {
              dockerfile: { content: "FROM scratch\nLABEL version=second\n" },
              platform: "linux/amd64",
              options: ["--provenance=false"],
            },
            publish: { repository },
          });
          return { first, second };
        });
        const definition = (platform = "linux/amd64", alwaysPull = true) =>
          Effect.gen(function* () {
            const images = yield* producers;
            const mirrored = yield* Docker.RemoteImage("Mirror", {
              source: images.first.name.pipe(
                Output.map((name) => `${name}:current`),
              ),
              platform,
              alwaysPull,
              publish: { repository: destination, tags: ["release"] },
            });
            const direct = yield* Docker.RemoteImage("Direct", {
              source: images.first.ref,
              publish: { repository },
            });
            return { ...images, mirrored, direct };
          });
        const first = yield* stack.deploy(definition());
        expect(first.direct.ref).toBe(first.first.ref);
        expect(first.mirrored.ref).toBe(
          `${destination}@${first.first.ref.split("@")[1]}`,
        );
        const unchanged = yield* stack.plan(definition());
        expect(unchanged.resources.Mirror).toMatchObject({ action: "noop" });
        yield* syncImageTags(first.second.ref, ["current"]);
        const drift = yield* stack.plan(definition());
        expect(drift.resources.Mirror).toMatchObject({ action: "update" });
        const changed = yield* stack.deploy(definition());
        expect(changed.mirrored.ref).not.toBe(first.mirrored.ref);
        expect(
          (yield* resolveImageManifest(`${destination}:release`)).ref,
        ).toBe(changed.mirrored.ref);
        const deleted = yield* client.del(
          `http://localhost:${port}/v2/mirror/manifests/${changed.mirrored.ref.split("@")[1]}`,
        );
        expect(deleted.status).toBe(202);
        const missing = yield* stack.plan(definition());
        expect(missing.resources.Mirror).toMatchObject({ action: "update" });
        const restored = yield* stack.deploy(definition());
        expect(restored.mirrored.ref).toBe(changed.mirrored.ref);
        expect(
          (yield* resolveImageManifest(`${destination}:release`)).ref,
        ).toBe(restored.mirrored.ref);
        const platform = yield* stack.plan(definition("linux/arm64", false));
        expect(platform.resources.Mirror).toMatchObject({ action: "update" });
        yield* stack.deploy(registry);
        expect((yield* resolveImageManifest(first.mirrored.ref)).ref).toBe(
          first.mirrored.ref,
        );
        expect((yield* resolveImageManifest(changed.mirrored.ref)).ref).toBe(
          changed.mirrored.ref,
        );
        yield* stack.destroy();
      }),
    { timeout: 120_000 },
  );
  test.provider("pulls a Docker image reference", (stack) =>
    Effect.gen(function* () {
      const image = yield* stack.deploy(
        Docker.RemoteImage("remote-nginx", {
          name: "nginx",
          tag: "alpine",
          alwaysPull: false,
        }),
      );
      expect(image.imageRef).toBe("nginx:alpine");
      expect(image.imageId).toMatch(/^sha256:/);
    }),
  );

  test.provider("pulls then re-tags under a new repository", (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const targetName = "alchemy-test-hello";
      const targetTag = "retagged";
      const targetRef = `${targetName}:${targetTag}`;
      // RemoteImage.delete is a no-op, so reclaim the re-tagged image here.
      yield* Effect.addFinalizer(() =>
        docker.image.remove([targetRef], true).pipe(Effect.ignore),
      );

      const image = yield* stack.deploy(
        Docker.RemoteImage("retagged-hello", {
          name: "hello-world",
          tag: "latest",
          targetName,
          targetTag,
        }),
      );
      expect(image.imageRef).toBe(targetRef);
      expect(image.name).toBe(targetName);
      expect(image.tag).toBe(targetTag);
      expect(image.imageId).toMatch(/^sha256:/);

      const inspected = yield* docker.image.inspect(targetRef);
      expect(inspected.Id.length).toBeGreaterThan(0);
    }),
  );

  test.provider("pulls, re-tags, and pushes to a registry", (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const client = yield* HttpClient.HttpClient;
      const port = yield* findAvailablePort();
      const registryName = "alchemy-test-registry";
      const host = `localhost:${port}`;
      const targetName = `${host}/alchemy-hello`;
      const targetTag = "v1";
      const targetRef = `${targetName}:${targetTag}`;

      yield* Effect.addFinalizer(() =>
        Effect.all([
          docker.run(["rm", "-f", registryName]),
          docker.image.remove(targetRef, true),
        ]).pipe(Effect.ignore),
      );

      yield* docker.run([
        "run",
        "-d",
        "--name",
        registryName,
        "-p",
        `${port}:5000`,
        "registry:2",
      ]);

      // Wait for the registry HTTP API to start serving before pushing.
      yield* client.get(`http://${host}/v2/`).pipe(
        Effect.retry({
          schedule: Schedule.exponential("250 millis"),
          times: 20,
        }),
      );

      const image = yield* stack.deploy(
        Docker.RemoteImage("pushed-hello", {
          name: "hello-world",
          tag: "latest",
          targetName,
          targetTag,
          registry: {
            server: host,
            username: "alchemy",
            password: Redacted.make("ignored-by-insecure-registry"),
          },
        }),
      );

      expect(image.imageRef).toBe(targetRef);
      expect(image.repoDigest).toBeDefined();
      expect(image.repoDigest).toContain(`${targetName}@sha256:`);
    }),
  );
});
