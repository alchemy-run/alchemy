import { hashDockerBuildInputs } from "@alchemy.run/docker/BuildHash";
import { computeStaticSourceHash } from "@alchemy.run/docker/ImageSource";
import { expect, layer } from "@alchemy.run/test";
import { BunServices } from "@effect/platform-bun";
import { AlchemyContext } from "alchemy/AlchemyContext";
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

/** Run with the project's `.alchemy` directory at `dotAlchemy`. */
const withDotAlchemy =
  (dotAlchemy: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(AlchemyContext, { dotAlchemy, dev: false, adopt: false }));

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

  // `.gitignore` doesn't decide what Docker receives. A gitignored build
  // output that the Dockerfile copies must still give the image a new tag.
  test.effect(
    "a gitignored file Docker receives changes the tag",
    () =>
      Effect.gen(function* () {
        const { fs, path, context } = yield* makeProject();
        yield* fs.writeFileString(path.join(context, ".gitignore"), "dist\n");
        yield* fs.makeDirectory(path.join(context, "dist"), { recursive: true });
        yield* fs.writeFileString(path.join(context, "dist", "main.js"), "v1\n");
        const before = yield* computeStaticSourceHash({ context }, "linux/amd64");
        yield* fs.writeFileString(path.join(context, "dist", "main.js"), "v2\n");
        expect(yield* computeStaticSourceHash({ context }, "linux/amd64")).not.toBe(before);
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );

  test.effect(
    "a file .dockerignore excludes does not change the tag",
    () =>
      Effect.gen(function* () {
        const { fs, path, context } = yield* makeProject();
        yield* fs.writeFileString(path.join(context, ".dockerignore"), "notes.md\n");
        yield* fs.writeFileString(path.join(context, "notes.md"), "draft\n");
        const before = yield* computeStaticSourceHash({ context }, "linux/amd64");
        yield* fs.writeFileString(path.join(context, "notes.md"), "edited\n");
        expect(yield* computeStaticSourceHash({ context }, "linux/amd64")).toBe(before);
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );

  // A project-root context (`context: "."`) also holds `.alchemy`, where every
  // run writes logs and local state. Hashing it would give the image a new tag
  // on every deploy — for `computeStaticSourceHash` and for every provider on
  // `hashDockerBuildInputs` (ECR, Lambda images, Cloudflare and Railway).
  test.effect(
    "Alchemy's own .alchemy directory in the context does not change the tag",
    () =>
      Effect.gen(function* () {
        const { fs, path, root } = yield* makeProject();
        const dotAlchemy = path.join(root, ".alchemy");
        yield* fs.writeFileString(path.join(root, "Dockerfile"), "FROM scratch\nCOPY app /app\n");
        yield* fs.makeDirectory(path.join(dotAlchemy, "log"), { recursive: true });
        const source = {
          context: root,
          dockerfile: "Dockerfile",
          platform: "linux/amd64",
        };
        const staticHash = computeStaticSourceHash({ context: root }, "linux/amd64").pipe(
          withDotAlchemy(dotAlchemy),
        );
        const buildHash = hashDockerBuildInputs(source, "effective").pipe(
          withDotAlchemy(dotAlchemy),
        );
        const before = { static: yield* staticHash, build: yield* buildHash };
        yield* fs.writeFileString(path.join(dotAlchemy, "log", "deploy.log"), "deployed\n");
        yield* fs.makeDirectory(path.join(dotAlchemy, "state"), { recursive: true });
        yield* fs.writeFileString(path.join(dotAlchemy, "state", "stack.json"), "{}\n");
        expect({ static: yield* staticHash, build: yield* buildHash }).toEqual(before);

        // Hashing without that `.alchemy` behind the context matches: the
        // directory is skipped, not just its contents.
        yield* fs.remove(dotAlchemy, { recursive: true });
        expect(yield* buildHash).toBe(before.build);
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );

  // Only Alchemy's configured directory is skipped. A user folder that
  // happens to be called `.alchemy` is a regular context file.
  test.effect(
    "a .alchemy folder that isn't the project's runtime directory still counts",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, context } = yield* makeProject();
        yield* fs.makeDirectory(path.join(context, ".alchemy"), { recursive: true });
        yield* fs.writeFileString(path.join(context, ".alchemy", "config"), "a\n");
        const hash = computeStaticSourceHash({ context }, "linux/amd64").pipe(
          withDotAlchemy(path.join(root, ".alchemy")),
        );
        const before = yield* hash;
        yield* fs.writeFileString(path.join(context, ".alchemy", "config"), "b\n");
        expect(yield* hash).not.toBe(before);
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );

  // Generated contexts live inside `.alchemy`; they must hash in full.
  test.effect(
    "a context inside the .alchemy directory is hashed in full",
    () =>
      Effect.gen(function* () {
        const { fs, path, root } = yield* makeProject();
        const dotAlchemy = path.join(root, ".alchemy");
        const generated = path.join(dotAlchemy, "contexts", "api");
        yield* fs.makeDirectory(generated, { recursive: true });
        yield* fs.writeFileString(path.join(generated, "Dockerfile"), "FROM scratch\nCOPY . /\n");
        yield* fs.writeFileString(path.join(generated, "main.js"), "v1\n");
        const hash = computeStaticSourceHash({ context: generated }, "linux/amd64").pipe(
          withDotAlchemy(dotAlchemy),
        );
        const before = yield* hash;
        yield* fs.writeFileString(path.join(generated, "main.js"), "v2\n");
        expect(yield* hash).not.toBe(before);
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );
});
