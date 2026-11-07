import { computeStaticSourceHash } from "@alchemy.run/docker/ImageSource";
import { expect, layer } from "@alchemy.run/test";
import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// A project with a lockfile at its root and a Docker build context in a
// subfolder, as in https://github.com/alchemy-run/alchemy/issues/3117.
const makeProject = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-image-source-hash-" });
  const context = path.join(root, "app");
  yield* fs.makeDirectory(context, { recursive: true });
  yield* fs.writeFileString(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  yield* fs.writeFileString(path.join(context, "Dockerfile"), "FROM scratch\nCOPY hello.txt /\n");
  yield* fs.writeFileString(path.join(context, "hello.txt"), "hello\n");
  return { fs, path, root, context };
});

layer(BunServices.layer)("Docker image source hash", (test) => {
  test.effect(
    "a lockfile outside the build context does not change the tag",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, context } = yield* makeProject();
        const before = yield* computeStaticSourceHash({ context }, "linux/amd64");
        yield* fs.writeFileString(
          path.join(root, "pnpm-lock.yaml"),
          "lockfileVersion: '9.0'\nsettings: {}\n",
        );
        expect(yield* computeStaticSourceHash({ context }, "linux/amd64")).toBe(before);
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );

  test.effect(
    "files Docker receives still change the tag",
    () =>
      Effect.gen(function* () {
        const { fs, path, context } = yield* makeProject();
        const hash = () => computeStaticSourceHash({ context }, "linux/amd64");
        const initial = yield* hash();

        yield* fs.writeFileString(path.join(context, "hello.txt"), "hello again\n");
        const afterFile = yield* hash();
        expect(afterFile).not.toBe(initial);

        yield* fs.writeFileString(
          path.join(context, "Dockerfile"),
          "FROM scratch\nCOPY hello.txt /hello.txt\n",
        );
        const afterDockerfile = yield* hash();
        expect(afterDockerfile).not.toBe(afterFile);

        expect(yield* computeStaticSourceHash({ context }, "linux/arm64")).not.toBe(
          afterDockerfile,
        );
        expect(
          yield* computeStaticSourceHash({ context, build: { args: { A: "1" } } }, "linux/amd64"),
        ).not.toBe(afterDockerfile);
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );

  // Docker receives a lockfile inside the context, so it is hashed like any
  // other context file.
  test.effect(
    "a lockfile inside the build context still changes the tag",
    () =>
      Effect.gen(function* () {
        const { fs, path, context } = yield* makeProject();
        yield* fs.writeFileString(path.join(context, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
        const before = yield* computeStaticSourceHash({ context }, "linux/amd64");
        yield* fs.writeFileString(
          path.join(context, "pnpm-lock.yaml"),
          "lockfileVersion: '9.0'\nsettings: {}\n",
        );
        expect(yield* computeStaticSourceHash({ context }, "linux/amd64")).not.toBe(before);
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );

  // A project-root context (`context: "."`) also holds `.alchemy`, which every
  // deploy writes to. Hashing it would give the image a new tag on every plan.
  test.effect(
    "deploy output in a project-root context does not change the tag",
    () =>
      Effect.gen(function* () {
        const { fs, path, root } = yield* makeProject();
        yield* fs.writeFileString(path.join(root, ".gitignore"), ".alchemy\n");
        yield* fs.writeFileString(path.join(root, "Dockerfile"), "FROM scratch\nCOPY app /app\n");
        yield* fs.makeDirectory(path.join(root, ".alchemy", "log"), { recursive: true });
        const before = yield* computeStaticSourceHash({ context: root }, "linux/amd64");
        yield* fs.writeFileString(path.join(root, ".alchemy", "log", "deploy.log"), "deployed\n");
        expect(yield* computeStaticSourceHash({ context: root }, "linux/amd64")).toBe(before);
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );
});
