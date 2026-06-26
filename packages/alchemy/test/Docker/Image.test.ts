import { hashDirectory } from "@/Command/Memo";
import * as Docker from "@/Docker";
import { desiredImageRef, localImageRef } from "@/Docker/Image";
import * as Provider from "@/Provider";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Vitest";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { spawnSync } from "node:child_process";

const dockerDaemonOk =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

const { test } = Test.make({
  providers: Docker.providers(),
  state: inMemoryState(),
  adopt: true,
});

const registry = {
  server: "ghcr.io",
  username: "octocat",
  password: Redacted.make("token"),
};

describe("ref helpers", () => {
  it("localImageRef falls back to the logical id for the repository", () => {
    expect(localImageRef("app-image", { build: { context: "." } })).toBe(
      "app-image:latest",
    );
  });

  it("localImageRef uses the explicit name and tag", () => {
    expect(
      localImageRef("app-image", {
        build: { context: "." },
        name: "acme/app",
        tag: "v1",
      }),
    ).toBe("acme/app:v1");
  });

  it("desiredImageRef prefixes the registry host when pushing", () => {
    expect(
      desiredImageRef("app-image", {
        build: { context: "." },
        name: "acme/app",
        tag: "v1",
        registry,
      }),
    ).toBe("ghcr.io/acme/app:v1");
  });

  it("desiredImageRef keeps the local ref when not pushing", () => {
    expect(
      desiredImageRef("app-image", {
        build: { context: "." },
        name: "acme/app",
        tag: "v1",
        registry,
        skipPush: true,
      }),
    ).toBe("acme/app:v1");
  });
});

test.provider("diff does not flag a spurious update when nothing changed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const imageProvider = yield* Provider.findProvider(Docker.Image);
    const buildDir = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-docker-canary-",
    });
    yield* fs.writeFileString(
      path.join(buildDir, "Dockerfile"),
      "FROM scratch\n",
    );
    const contextHash = yield* hashDirectory({ cwd: buildDir });
    const imageProps = {
      name: "acme/app",
      tag: "latest",
      build: { context: buildDir },
      registry,
    };
    // Registry-host prefixing must not look like a change:
    // desiredImageRef("acme/app:latest") resolves to "ghcr.io/acme/app:latest".
    const imageDiff = yield* imageProvider.diff!({
      id: "app-image",
      instanceId: "instance",
      olds: imageProps,
      news: imageProps,
      oldBindings: [],
      newBindings: [],
      output: {
        name: "ghcr.io/acme/app",
        imageRef: "ghcr.io/acme/app:latest",
        imageId: "sha256:0",
        tag: "latest",
        builtAt: 0,
        contextHash,
      },
    });
    expect(imageDiff).toBeUndefined();
  }),
);

describe.sequential("Docker.Image", () => {
  test.provider.skipIf(!dockerDaemonOk)(
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
        expect(image.imageId.length).toBeGreaterThan(0);
        expect(image.contextHash?.length).toBeGreaterThan(0);
      }),
    { timeout: 120000 },
  );

  test.provider.skipIf(!dockerDaemonOk)(
    "builds with an explicit repository name and tag",
    (stack) =>
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
    { timeout: 120000 },
  );

  test.provider.skipIf(!dockerDaemonOk)(
    "rebuilds when the build context changes",
    (stack) =>
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
        expect(second.contextHash).not.toBe(first.contextHash);
      }),
    { timeout: 120000 },
  );
});
