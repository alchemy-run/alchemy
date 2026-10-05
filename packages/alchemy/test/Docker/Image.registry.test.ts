import { expect } from "alchemy-test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { Docker, DockerLive } from "@/Docker/Docker.ts";
import { Image, ImageProvider } from "@/Docker/Image.ts";
import { Providers } from "@/Docker/Providers.ts";
import * as Provider from "@/Provider.ts";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy.ts";

class Registry extends Context.Service<
  Registry,
  {
    manifests: Map<string, string>;
    builds: Array<string>;
  }
>()("test/Registry") {}

const registry = { server: "registry.invalid", username: "test", password: Redacted.make("test") };
const registryLayer = Layer.sync(Registry, () => ({ manifests: new Map(), builds: [] }));
const dockerLayer = Layer.effect(
  Docker,
  Effect.gen(function* () {
    const docker = yield* Docker;
    const { manifests, builds } = yield* Registry;
    return Docker.of({
      ...docker,
      image: {
        ...docker.image,
        inspect: () => Effect.die("Registry images must not inspect a local engine"),
        remove: () => Effect.die("Registry images must not delete a local image"),
        registryDigest: (ref) => Effect.sync(() => manifests.get(ref)),
        build: (options, _session, credentials) =>
          Effect.sync(() => {
            expect(credentials).toEqual(registry);
            expect(options.platform).toBe("linux/amd64");
            const ref = typeof options.tag === "string" ? options.tag : options.tag[0];
            builds.push(ref);
            manifests.set(ref, `sha256:${String(builds.length).padStart(64, "0")}`);
            return { exitCode: 0, stdout: "", stderr: "" };
          }),
      },
    });
  }),
).pipe(Layer.provide(DockerLive), Layer.provideMerge(registryLayer));
const { test } = Test.make({
  state: inMemoryState(),
  providers: Layer.effect(Providers, Provider.collection([Image])).pipe(
    Layer.provide(ImageProvider()),
    Layer.provideMerge(dockerLayer),
  ),
});

test.provider(
  "registry publication plans without building, reuses images, and repairs drift",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { manifests, builds } = yield* Registry;
      const context = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-registry-image-" });
      const dockerfile = path.join(context, "Dockerfile");
      yield* fs.writeFileString(dockerfile, "FROM scratch\nLABEL version=1\n");
      const program = Image("image", { name: "test/app", registry, build: { context } });
      yield* stack.plan(program);
      expect(builds).toHaveLength(0);
      const first = yield* stack.deploy(program);
      expect(first.imageId).toBeUndefined();
      expect(first.tag).toMatch(/^[a-f0-9]{64}$/);
      expect(first.imageRef).toBe(first.repoDigest);
      expect(first.repoDigest).toMatch(/^registry.invalid\/test\/app@sha256:/);
      expect(builds).toHaveLength(1);
      const unchanged = yield* stack.plan(program);
      expect(unchanged.resources.image).toMatchObject({ action: "noop" });
      expect(builds).toHaveLength(1);

      yield* fs.writeFileString(dockerfile, "FROM scratch\nLABEL version=2\n");
      const changed = yield* stack.plan(program);
      expect(changed.resources.image).toMatchObject({ action: "update" });
      expect(builds).toHaveLength(1);
      const second = yield* stack.deploy(program);
      expect(second.repoDigest).not.toBe(first.repoDigest);
      expect(builds).toHaveLength(2);

      yield* fs.writeFileString(dockerfile, "FROM scratch\nLABEL version=1\n");
      const restored = yield* stack.deploy(program);
      expect(restored.repoDigest).toBe(first.repoDigest);
      expect(builds).toHaveLength(2);
      yield* Effect.sync(() => manifests.delete(builds[0]!));
      yield* stack.deploy(program);
      expect(builds).toHaveLength(3);
      yield* stack.destroy();
      expect(manifests.has(builds[0]!)).toBe(true);
      // Fresh state has no record of an engine or previous publication.
      yield* stack.deploy(program);
      expect(builds).toHaveLength(3);
      yield* stack.destroy();
    }),
  { tags: ["unit", "provider:docker", "local"] },
);

test.provider(
  "explicit tags rebuild on changed inputs and detect registry tag drift",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { manifests, builds } = yield* Registry;
      const context = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-registry-tag-" });
      yield* fs.writeFileString(path.join(context, "Dockerfile"), "FROM scratch\n");
      const program = Image("image", {
        name: "test/tagged",
        tag: "latest",
        registry,
        build: { context },
      });
      const first = yield* stack.deploy(program);
      yield* Effect.sync(() => manifests.set(builds[0]!, `sha256:${"f".repeat(64)}`));
      const plan = yield* stack.plan(program);
      expect(plan.resources.image).toMatchObject({ action: "update" });
      const before = builds.length;
      const repaired = yield* stack.deploy(program);
      expect(builds).toHaveLength(before + 1);
      expect(repaired.repoDigest).not.toContain("f".repeat(64));
      yield* fs.writeFileString(
        path.join(context, "Dockerfile"),
        "FROM scratch\nLABEL changed=true\n",
      );
      const changed = yield* stack.deploy(program);
      expect(changed.tag).toBe(first.tag);
      expect(changed.imageRef).not.toBe(first.imageRef);
      expect(changed.repoDigest).not.toBe(repaired.repoDigest);
      yield* stack.destroy();
    }),
  { tags: ["unit", "provider:docker", "local"] },
);
